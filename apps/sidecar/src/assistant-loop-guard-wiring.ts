// Feeds the sidecar's verified InferenceEvent stream into the
// `@workbench/hub-agent` assistant-loop guard (WORKBENCH-LOCAL CL-3340) and
// reacts to a trip. The guard's own fingerprinting/state-machine logic is
// unchanged; this module is only the re-home of its consumer onto the
// workflow-host inference-event seam (`onInferenceEvent` in
// `workflow-host-wiring.ts`) that replaced the retired in-process
// SessionManager the guard used to hook.

import { getLogger } from "@intx/log";
import type { ContentBlock, InferenceEvent } from "@intx/types/runtime";
import {
  assistantCycleFingerprint,
  type AssistantLoopGuard,
} from "@workbench/hub-agent";

const logger = getLogger(["sidecar", "assistant-loop-guard-wiring"]);

type FingerprintBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
};

/**
 * `ContentBlock` is a wider union (image/audio/video/document/citation/code
 * execution blocks) than the guard's fingerprint cares about; the guard
 * itself already ignores every type but "text" and "tool_call". Narrowing
 * here (rather than widening the guard's exported `CycleBlock` type) keeps
 * the guard's pure module untouched, per its reuse contract.
 */
function toFingerprintBlocks(
  content: readonly ContentBlock[],
): FingerprintBlock[] {
  return content.map((block): FingerprintBlock => {
    if (block.type === "text") return { type: block.type, text: block.text };
    if (block.type === "tool_call") {
      return {
        type: block.type,
        id: block.id,
        name: block.name,
        arguments: block.arguments,
      };
    }
    return { type: block.type };
  });
}

export type AssistantLoopGuardHooks = {
  guard: AssistantLoopGuard;
  /** Stable per-deployment identity; the guard's per-key run state. */
  sessionKey: string;
  /**
   * Forwards an event through the same `publishWorkflowInferenceEvent` path
   * real inference events use, so a synthetic trip notice reaches the hub
   * timeline exactly like any other event.
   */
  publish: (event: InferenceEvent) => void;
  /**
   * The deployment's supervisor `drain` call. `deadlineMs: 0` arms the
   * drainTimeout accumulator with no runway, so it escalates to a signed
   * `CancelRequested{origin: "supervisor-drain"}` immediately instead of
   * waiting out the normal operator-drain window -- the abort lever this
   * wiring uses to stop a looping turn.
   */
  drain: (deadlineMs: number) => Promise<void>;
};

/**
 * Records one verified `InferenceEvent` against the assistant loop guard
 * and reacts to a trip. Only `inference.done` carries a finalized cycle's
 * `turn.content` (the shape the guard fingerprints); every other event
 * type is a no-op pass-through here -- the caller is expected to have
 * already forwarded the event to the hub via `publish` before calling this
 * (or after; this function does not republish the source event).
 *
 * On a trip: publishes a synthetic `inference.error` (category "aborted",
 * message `assistantLoopInterruptMessage`) through `hooks.publish` --
 * `@workbench/event-collector`'s existing `inference.error` handling
 * already turns that into a visible, eagerly-persisted turn part, so no
 * new user-facing surface is needed -- and drains the deployment
 * (`hooks.drain(0)`) so the runtime's existing cancellation cascade tears
 * the looping run down. A drain failure is logged, not thrown: the guard
 * having already surfaced the interrupt notice to the user is the more
 * important side effect if the drain call itself is unreachable (e.g. the
 * supervisor is mid-teardown).
 */
export function observeInferenceEventForAssistantLoopGuard(
  event: InferenceEvent,
  hooks: AssistantLoopGuardHooks,
): void {
  if (event.type !== "inference.done") return;
  const fingerprint = assistantCycleFingerprint(
    toFingerprintBlocks(event.data.turn.content),
  );
  if (fingerprint === "") return;
  const tripMessage = hooks.guard.recordAssistantOutput(
    hooks.sessionKey,
    fingerprint,
  );
  if (tripMessage === undefined) return;
  logger.warn`assistant loop guard tripped for ${hooks.sessionKey}: ${tripMessage}`;
  hooks.publish({
    type: "inference.error",
    seq: event.seq + 1,
    data: {
      error: { category: "aborted", message: tripMessage },
      partial: { text: "" },
    },
  });
  hooks.drain(0).catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    logger.error`assistant loop guard drain failed for ${hooks.sessionKey}: ${message}`;
  });
}
