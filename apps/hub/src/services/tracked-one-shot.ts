import {
  createAgent,
  createDefaultDirectorRegistry,
  defineAgent,
  type AuthorizeFn,
} from "@intx/agent";
import type { InboundMessage, InferenceSource } from "@intx/types/runtime";
import { parseInferenceEvent } from "@intx/types/runtime";
import { type } from "arktype";
import type { AuditStore, ContextStore } from "@workbench/storage-isogit";
import {
  createEventCollector,
  type TurnFinalized,
} from "@workbench/event-collector";
import type { AnalyticsSubscriber } from "@workbench/analytics";
import { randomUUID } from "node:crypto";
import { getLogger } from "@intx/log";
import type { HubDb } from "../db";

const log = getLogger(["services", "tracked-one-shot"]);

const ALLOW_ALL_AUTHORIZE: AuthorizeFn = async () => ({
  effect: "allow" as const,
  matchingGrants: [],
  resolvedBy: null,
});

/**
 * Thrown when a tracked one-shot turn's inference cycle ended in an
 * unrecoverable `inference.error` (the last inference-related event in the
 * stream, since a cycle's `for(;;)` loop returns immediately on either
 * success or exhausted retries — see reactor.ts). On this path the default
 * director still replies with SDK-synthesized apology text via
 * `capabilities.reply()` (e.g. "...due to a credential error [HTTP 402]:
 * ..."), so `send()`/the collector resolve normally with THAT text looking
 * like a real completion. Every one-shot caller (title generation, file
 * parsing, Granola analysis) must treat this as a failure, not usable output.
 */
export class InferenceTurnFailedError extends Error {
  constructor(detail: { category: string; message: string }) {
    super(`Inference turn failed (${detail.category}): ${detail.message}`);
    this.name = "InferenceTurnFailedError";
  }
}

// Best-effort teardown: cleanup must not throw over the real result/error, but
// the failure is logged rather than silently dropped.
const logTeardownError = (op: string) => (err: unknown) =>
  log.warn(`Tracked one-shot teardown failed: ${op}`, {
    error: err instanceof Error ? err.message : String(err),
  });

/**
 * Emit this one-shot's token usage to the analytics pipeline, attributed to the
 * CALLER's active instance (its synthetic principal), so its cost rolls up to
 * the same person as the caller's own usage via the member_agent_instance join.
 */
export type OneShotAnalytics = {
  subscriber: AnalyticsSubscriber;
  attributionPrincipalId: string;
};

/**
 * Record the assistant turn to `inference_turn`/`turn_part` under this session +
 * instance. Omit to run without a persisted message record (usage-only).
 */
export type OneShotTurnRecording = {
  sessionId: string;
  instanceId: string;
};

export type RunTrackedOneShotOptions = {
  db: HubDb;
  tenantId: string;
  source: InferenceSource;
  systemPrompt: string;
  /** Prefix for the ephemeral agent id (e.g. "myra-title", "file-parser"). */
  agentIdPrefix: string;
  message: string | InboundMessage;
  /**
   * The @intx/agent scratch store for this turn (context + audit). The caller
   * owns its lifecycle: pass a throwaway store for a stateless one-shot, or a
   * durable one when the trace must be kept. The store is never grown across
   * turns here — one turn per store keeps the write-path commit cheap.
   */
  store: ContextStore & AuditStore;
  workdir: string;
  analytics?: OneShotAnalytics;
  turnRecording?: OneShotTurnRecording;
  /** Fired by a caller deadline; aborts the turn and releases the workdir lock. */
  signal?: AbortSignal;
};

/**
 * Run ONE non-streaming @intx/agent turn (no tools) and return its reply text,
 * with unified tracking. A single pump over the event stream does both jobs the
 * hub's one-shots previously did separately: forward usage-bearing inference
 * events to analytics (so tokens roll up per person in /insights) AND, when a
 * session is given, record the turn to inference_turn/turn_part. Callers own the
 * scratch store's durability and any deadline; this owns the agent lifecycle,
 * the abort→close teardown (CL-2866), and the return-text resolution.
 */
export async function runTrackedOneShot(
  opts: RunTrackedOneShotOptions,
): Promise<string> {
  const def = defineAgent({
    id: `${opts.agentIdPrefix}-${randomUUID()}`,
    systemPrompt: opts.systemPrompt,
    tools: [],
    capabilities: [],
    inference: {
      sources: [{ provider: opts.source.provider, model: opts.source.model }],
    },
  });

  const env = {
    sources: [opts.source],
    defaultSource: opts.source.id,
    storage: opts.store,
    workdir: opts.workdir,
    audit: opts.store,
    authorize: ALLOW_ALL_AUTHORIZE,
    directors: createDefaultDirectorRegistry(),
    closeTimeoutMs: 1000,
  };

  let finalizedText: string | null = null;
  const collector = opts.turnRecording
    ? createEventCollector({
        db: opts.db,
        sessionId: opts.turnRecording.sessionId,
        instanceId: opts.turnRecording.instanceId,
        tenantId: opts.tenantId,
        onTurnFinalized: (turn: TurnFinalized) => {
          if (turn.status === "completed" && turn.text.trim() !== "") {
            finalizedText = turn.text;
          }
        },
      })
    : null;

  const agentInst = await createAgent(def, env);

  // On deadline (CL-2866) close() releases the agent workdir lock so a wedged
  // turn cannot pin its scratch store. It is idempotent, so the success/catch
  // paths below may safely close again.
  const onAbort = () => {
    void agentInst.close().catch(logTeardownError("abort close agent"));
  };
  const signal = opts.signal;
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  const analytics = opts.analytics;

  // Last-write-wins across the stream: each inference cycle's `for(;;)` loop
  // (reactor.ts) returns immediately after emitting its terminal
  // inference.done or inference.error, so whichever of the two was observed
  // LAST reflects that cycle's real outcome — a transient inference.error
  // from a retried/failed-over attempt is always superseded by the eventual
  // inference.done when the turn recovers.
  let lastInferenceOutcome: "done" | "error" | null = null;
  let lastInferenceErrorDetail: { category: string; message: string } | null =
    null;

  async function pumpStream(): Promise<void> {
    for await (const event of agentInst.stream()) {
      if (event.type === "inference.done") {
        lastInferenceOutcome = "done";
      } else if (event.type === "inference.error") {
        lastInferenceOutcome = "error";
        lastInferenceErrorDetail = event.data.error;
      }
      // The two sinks are independent best-effort tracking. Isolate each so a
      // failure in one (an analytics outage, a collector write error) cannot
      // starve the other of the rest of the stream — including the finalization
      // event the collector needs to capture the turn's text.
      if (analytics) {
        try {
          const validated = parseInferenceEvent(event);
          if (!(validated instanceof type.errors)) {
            await analytics.subscriber.onLocalInferenceEvent({
              tenantId: opts.tenantId,
              attributionPrincipalId: analytics.attributionPrincipalId,
              eventAddress: def.id,
              event: validated,
            });
          }
        } catch (err) {
          logTeardownError("analytics forward")(err);
        }
      }
      if (collector && event.type !== "message.received") {
        try {
          await collector.onEvent(event);
        } catch (err) {
          logTeardownError("collector record")(err);
        }
      }
    }
  }

  const pumpDone = pumpStream();
  let text: string;
  try {
    const result = await agentInst.send(opts.message);
    await agentInst.close();
    await pumpDone.catch(logTeardownError("pump stream"));
    if (collector) await collector.abandon();
    // `SendResult` is a discriminated union since the approval-suspension
    // bump; a tracked one-shot carries no approval gate, so only the reply
    // variant yields text (a suspended result falls through to "").
    const replyText = result.type === "reply" ? result.reply : "";
    text = finalizedText ?? collector?.getAccumulatedText() ?? replyText;
  } catch (err) {
    await agentInst.close().catch(logTeardownError("close agent"));
    await pumpDone.catch(logTeardownError("pump stream"));
    if (collector) {
      await collector.abandon().catch(logTeardownError("abandon collector"));
    }
    throw err;
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
  // The turn's own inference cycle ended in an unrecoverable error: `text` is
  // the director's SDK-synthesized apology text (capabilities.reply), not a
  // real completion. Callers must see this as a failure, never as usable
  // output (CL-3870) — surfacing it as text let a failed title turn persist
  // the error message as if it were a generated title.
  if (lastInferenceOutcome === "error" && lastInferenceErrorDetail) {
    throw new InferenceTurnFailedError(lastInferenceErrorDetail);
  }
  return text;
}
