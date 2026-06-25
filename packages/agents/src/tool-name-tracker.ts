import type { Transport } from "@intx/hub-client";

/**
 * Captures tool names from the live agent event stream, keyed by callId.
 *
 * The agent runtime can fail to persist the tool "call" part that carries a
 * tool's real name (see CL-1398), in which case the raw call ID surfaces as the
 * tool name in committed turns. The live `inference.tool_call.start` and
 * `.end` events, however, always carry both the callId and the real name. We
 * subscribe to the same event stream the session uses, accumulate a durable
 * callId → name map, and hand it to `convertInstanceEvents` so the UI renders
 * the actual tool instead of a generic "Tool call".
 */
export interface ToolNameTracker {
  /** Live callId → tool-name map. Mutated in place as events arrive. */
  readonly names: ReadonlyMap<string, string>;
  /** Tears down the underlying event subscription. */
  stop: () => void;
}

interface ToolCallNameEvent {
  type: "inference.tool_call.start" | "inference.tool_call.end";
  data: { callId: string; name: string };
}

function parseToolCallNameEvent(raw: unknown): ToolCallNameEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { type, data } = raw as { type?: unknown; data?: unknown };
  if (
    type !== "inference.tool_call.start" &&
    type !== "inference.tool_call.end"
  ) {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { callId, name } = data as { callId?: unknown; name?: unknown };
  if (typeof callId !== "string" || typeof name !== "string") return null;
  return { type, data: { callId, name } };
}

export function createToolNameTracker(
  transport: Transport,
  params: { tenantId: string; instanceId: string },
  onUpdate?: () => void,
): ToolNameTracker {
  const names = new Map<string, string>();
  const path = `/api/tenants/${params.tenantId}/agents/instances/${params.instanceId}/events`;

  const stop = transport.subscribe(
    path,
    (raw) => {
      const event = parseToolCallNameEvent(raw);
      if (event === null) return;
      if (names.get(event.data.callId) === event.data.name) return;
      names.set(event.data.callId, event.data.name);
      onUpdate?.();
    },
    { eventName: "agent.event" },
  );

  return { names, stop };
}
