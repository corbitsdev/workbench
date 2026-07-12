import { getLogger } from "@intx/log";
import type {
  ToolCall,
  ToolResult,
  ToolDefinition,
  ToolRunner,
} from "@intx/types/runtime";

const logger = getLogger(["sidecar", "mail-guard"]);

/** Mail tools that emit outbound messages and so can run away in a loop. */
const MAIL_WRITE_TOOLS = new Set(["mail_send", "mail_reply"]);

/**
 * How many times the same exact body may be sent. The first send goes through;
 * any further identical body is suppressed — the ~15 repeated browser-error
 * replies we saw in production were all byte-identical.
 */
export const MAX_IDENTICAL_OUTBOUND = 1;

/**
 * Hard ceiling on outbound mail within a single inbound-message turn. A
 * backstop against distinct-but-looping sends that the dedupe pass cannot catch.
 * Generous enough for legitimate multi-recipient fan-out.
 */
export const MAX_OUTBOUND_PER_TURN = 8;

/**
 * Prefix identifying an agent-instance mailbox address, as opposed to a
 * member (`usr_`) mailbox. Only agent recipients are subject to the
 * cross-turn correspondent bound below — member conversations must never be
 * throttled by it.
 */
const AGENT_ADDRESS_PREFIX = "ins_";

/**
 * Cross-turn ceiling on sends to the same agent correspondent within the
 * rolling window below. `resetOutboundBudget()` runs on every inbound
 * message, so two agents mailing each other reset each other's per-turn
 * budgets on every exchange — an unattended ping-pong is otherwise unbounded.
 * This counter is deliberately NOT reset by `resetOutboundBudget()`; it is
 * the only backstop that survives across turns. 10/hour is generous for any
 * legitimate multi-step agent-to-agent handoff (a handful of exchanges to
 * negotiate or relay work) while still cutting off a runaway loop within
 * minutes at typical agent turnaround speed.
 */
export const MAX_OUTBOUND_PER_CORRESPONDENT = 10;

/** Rolling window over which `MAX_OUTBOUND_PER_CORRESPONDENT` is enforced. */
export const CORRESPONDENT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Ceiling on distinct agent correspondents tracked at once. A long-lived
 * sidecar that talks to many different agent instances over its lifetime
 * must not grow this map unboundedly; least-recently-touched correspondents
 * are evicted first once the cap is hit.
 */
export const MAX_TRACKED_CORRESPONDENTS = 500;

type DefinedRunner = ToolRunner & { definitions: ToolDefinition[] };

export type GuardedMailRunner = DefinedRunner & { resetOutboundBudget(): void };

export type GuardedMailRunnerOptions = {
  maxOutboundPerTurn?: number;
  maxOutboundPerCorrespondent?: number;
  correspondentWindowMs?: number;
  maxTrackedCorrespondents?: number;
  now?: () => number;
};

function blocked(call: ToolCall, message: string): ToolResult {
  return { callId: call.id, content: { error: message }, isError: true };
}

function bodyOf(call: ToolCall): string {
  const content = call.arguments.content;
  return typeof content === "string" ? content.trim() : "";
}

/**
 * Identify the recipient so dedupe is per-destination: mail_send carries `to`,
 * mail_reply targets the message `ref`. Keying on body alone would wrongly
 * suppress a legitimate fan-out of the same body to different recipients.
 */
function recipientOf(call: ToolCall): string {
  const to = call.arguments.to;
  if (typeof to === "string") return to;
  return JSON.stringify(call.arguments.ref ?? "");
}

/**
 * Only `to`-addressed sends carry a resolvable agent address up front;
 * `mail_reply` targets a message `ref` that this guard cannot map to an
 * address without the mailbox, so the cross-turn correspondent bound only
 * applies to direct `mail_send` calls naming an `ins_` recipient.
 */
function agentRecipientOf(call: ToolCall): string | undefined {
  const to = call.arguments.to;
  if (typeof to === "string" && to.startsWith(AGENT_ADDRESS_PREFIX)) return to;
  return undefined;
}

/**
 * Wrap a mail tool runner with a per-lifetime circuit breaker: suppress
 * byte-identical resends and cap total outbound volume, returning a structured
 * error the agent sees instead of letting a loop flood recipients. Read-only
 * mail tools (search/read/wait) pass through untouched. The harness resets
 * per-turn state on each inbound message, so a long-running agent does not
 * exhaust the per-turn budget across unrelated work — but that same reset is
 * what lets two agents mailing each other run away, since each inbound
 * message from the other agent resets the sender's own per-turn budget. The
 * correspondent bound (`MAX_OUTBOUND_PER_CORRESPONDENT`) survives across
 * turns for exactly that reason, and applies only to `ins_` (agent) mailbox
 * recipients — member (`usr_`) conversations are governed solely by the
 * per-turn budget so a human chat is never throttled.
 *
 * This is a runtime safety guard at the harness-composition seam, not a
 * product rule: it protects against loops from any cause (weak model, retry
 * storms, future bugs), which is why it lives here rather than relying on the
 * agent prompt to behave.
 */
export function createGuardedMailRunner(
  inner: DefinedRunner,
  options: GuardedMailRunnerOptions = {},
): GuardedMailRunner {
  const maxOutboundPerTurn =
    options.maxOutboundPerTurn ?? MAX_OUTBOUND_PER_TURN;
  const maxOutboundPerCorrespondent =
    options.maxOutboundPerCorrespondent ?? MAX_OUTBOUND_PER_CORRESPONDENT;
  const correspondentWindowMs =
    options.correspondentWindowMs ?? CORRESPONDENT_WINDOW_MS;
  const maxTrackedCorrespondents =
    options.maxTrackedCorrespondents ?? MAX_TRACKED_CORRESPONDENTS;
  const now = options.now ?? Date.now;
  let outboundCount = 0;
  const sentKeys = new Map<string, number>();
  // Cross-turn, per-agent-correspondent send timestamps. Deliberately NOT
  // cleared by resetOutboundBudget() — see MAX_OUTBOUND_PER_CORRESPONDENT.
  // Map insertion order doubles as LRU order: touching a key re-inserts it.
  const correspondentSends = new Map<string, number[]>();

  function pruneCorrespondent(address: string, nowMs: number): number[] {
    const existing = correspondentSends.get(address);
    if (!existing) return [];
    const fresh = existing.filter((ts) => nowMs - ts < correspondentWindowMs);
    correspondentSends.delete(address);
    if (fresh.length > 0) correspondentSends.set(address, fresh);
    return fresh;
  }

  function recordCorrespondentSend(address: string, nowMs: number): void {
    const fresh = pruneCorrespondent(address, nowMs);
    fresh.push(nowMs);
    correspondentSends.delete(address);
    correspondentSends.set(address, fresh);
    while (correspondentSends.size > maxTrackedCorrespondents) {
      const oldest = correspondentSends.keys().next().value;
      if (oldest === undefined) break;
      correspondentSends.delete(oldest);
    }
  }

  return {
    definitions: inner.definitions,
    resetOutboundBudget() {
      outboundCount = 0;
      sentKeys.clear();
    },
    async run(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
      if (!MAIL_WRITE_TOOLS.has(call.name)) {
        return inner.run(call, signal);
      }

      if (outboundCount >= maxOutboundPerTurn) {
        logger.warn("Outbound mail cap reached for {tool}: {count} sent", {
          tool: call.name,
          count: outboundCount,
        });
        return blocked(
          call,
          `Outbound mail cap reached (${maxOutboundPerTurn} this turn). Stop sending — your turn is done.`,
        );
      }

      const agentRecipient = agentRecipientOf(call);
      if (agentRecipient !== undefined) {
        const nowMs = now();
        const recentSends = pruneCorrespondent(agentRecipient, nowMs);
        if (recentSends.length >= maxOutboundPerCorrespondent) {
          logger.warn(
            "Suppressed outbound mail to {recipient}: correspondent cap reached",
            { recipient: agentRecipient, count: recentSends.length },
          );
          return blocked(
            call,
            "Too many messages to this agent recently — cross-turn correspondent cap reached. Do not resend; your turn is done.",
          );
        }
      }

      const body = bodyOf(call);
      const key = `${recipientOf(call)}\u001f${body}`;
      const alreadySent = sentKeys.get(key) ?? 0;
      if (body.length > 0 && alreadySent >= MAX_IDENTICAL_OUTBOUND) {
        logger.warn("Suppressed duplicate outbound mail for {tool}", {
          tool: call.name,
        });
        return blocked(
          call,
          "Duplicate outbound mail suppressed — you already sent this exact message to this recipient. Do not resend; your turn is done.",
        );
      }

      const result = await inner.run(call, signal);
      if (!result.isError) {
        outboundCount += 1;
        if (body.length > 0) sentKeys.set(key, alreadySent + 1);
        if (agentRecipient !== undefined) {
          recordCorrespondentSend(agentRecipient, now());
        }
      }
      return result;
    },
  };
}
