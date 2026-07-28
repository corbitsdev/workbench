import type { Transport } from "@intx/hub-client";

/**
 * Run-level busy flag for the composer send-button spinner (and CL-2988 queue).
 *
 * Distinct from micro `activity` (open reasoning/tool part) and from the
 * sidebar phase tracker: a multi-turn agent response must keep the spinner
 * continuous across tools, answer-text streaming, and turn boundaries, while
 * the activity pill stays free to drop during text (CL-3871).
 *
 * `busy` is one signal shared by the spinner, the stop control, and the
 * composer queue (auto-drain only when busy goes true → false). Keep it true
 * for the whole active cycle — including approval gates — so a queued follow-up
 * does not fire while the reactor is still suspended. Clear only when the
 * cycle is actually over: `connector.reply`, reactor terminals, or a
 * content-less wait decision.
 */
export interface RunBusyTracker {
  readonly busy: boolean;
  stop: () => void;
}

const CLEAR_EVENTS = new Set([
  "connector.reply",
  "reactor.done",
  "reactor.abort",
  "reactor.error",
  "inference.error",
]);

function eventType(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { type } = raw as { type?: unknown };
  return typeof type === "string" ? type : null;
}

function isContentlessInferenceDone(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const { data } = raw as { data?: unknown };
  if (typeof data !== "object" || data === null) return false;
  const { turn } = data as { turn?: unknown };
  if (typeof turn !== "object" || turn === null) return false;
  const { content } = turn as { content?: unknown };
  return Array.isArray(content) && content.length === 0;
}

export function createRunBusyTracker(
  transport: Transport,
  params: { tenantId: string; instanceId: string },
  onUpdate?: () => void,
): RunBusyTracker {
  let busy = false;

  const path = `/api/tenants/${params.tenantId}/agents/instances/${params.instanceId}/events`;

  function setBusy(next: boolean) {
    if (next === busy) return;
    busy = next;
    onUpdate?.();
  }

  const stop = transport.subscribe(
    path,
    (raw) => {
      const type = eventType(raw);
      if (type === null) return;

      if (CLEAR_EVENTS.has(type)) {
        setBusy(false);
        return;
      }

      if (type === "inference.done") {
        if (isContentlessInferenceDone(raw)) {
          setBusy(false);
        }
        return;
      }

      // Productive work: start of inference, streamed text/thinking, tools.
      // turn.committed is intentionally ignored so multi-turn runs stay busy
      // through the gap until the next inference.start or a clear event.
      // Gate blocked/cleared are also ignored: busy stays true through
      // approval so the composer queue does not auto-drain mid-run.
      if (
        type === "inference.start" ||
        type === "inference.text.delta" ||
        type === "inference.thinking.delta" ||
        type === "inference.tool" ||
        type === "tool.start" ||
        type === "tool.running"
      ) {
        setBusy(true);
      }
    },
    { eventName: "agent.event" },
  );

  return {
    get busy() {
      return busy;
    },
    stop,
  };
}
