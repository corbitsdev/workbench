import type { InstanceEvent } from '@intx/hub-client';
import type { ChatMessage, ToolCall } from '@workbench/chat';

function stripContextBlock(content: string): string {
  return content.replace(/^<context>[\s\S]*?<\/context>\n*/u, '');
}

// Anthropic raw call IDs (e.g. "call_00_AbCdEf123456") are not human-readable.
// When the agent runtime fails to persist the tool "call" part that carries the
// real name, the raw call ID flows through as the tool name. The web app
// captures the real names from the live stream (see tool-name-tracker) and
// passes them here so the UI can render the actual tool instead of "Tool call".
const RAW_CALL_ID = /^call_[0-9A-Za-z_]{10,}$/u;

function resolveToolName(name: string, toolNames?: ReadonlyMap<string, string>): string {
  if (toolNames !== undefined && RAW_CALL_ID.test(name)) {
    const resolved = toolNames.get(name);
    if (resolved !== undefined) return resolved;
  }
  return name;
}

/**
 * Convert a list of InstanceEvents from the hub-client into ChatMessages
 * suitable for rendering in the web UI.
 *
 * Mapping rules:
 *   - mail event, role "user"      → ChatMessage role "user"
 *   - mail event, role "assistant" → ChatMessage role "agent"
 *   - turn event                   → ChatMessage role "agent"
 *   - isError: true                → status "failed"
 *   - otherwise                    → status omitted
 *
 * `toolNames` is an optional callId → tool-name map captured from the live
 * event stream. Tool calls whose name arrives as a raw call ID are resolved
 * through it; readable names and unknown IDs pass through unchanged.
 */
export function convertInstanceEvents(
  events: InstanceEvent[],
  toolNames?: ReadonlyMap<string, string>
): ChatMessage[] {
  // Do not re-sort. The session maintains correct insertion order:
  // hydration sorts by server timestamps, then live SSE events are appended
  // in arrival order. Re-sorting corrupts order when turn events carry
  // client-side timestamps that land after a subsequent user mail's server
  // timestamp.
  return events.map((event): ChatMessage => {
    if (event.kind === 'mail') {
      return {
        id: event.id,
        role: event.role === 'user' ? 'user' : 'agent',
        content: event.role === 'user' ? stripContextBlock(event.content) : event.content,
        createdAt: event.timestamp,
        ...(event.isError === true ? { status: 'failed' as const } : {}),
      };
    }

    // kind === "turn"
    const toolCalls: ToolCall[] | undefined = event.toolCalls?.map((tc, i) => ({
      id: `${event.turnId}-${i}`,
      name: resolveToolName(tc.name, toolNames),
      ...(tc.arguments !== undefined ? { arguments: tc.arguments } : {}),
      result: tc.result,
      isError: tc.isError === true,
    }));

    return {
      id: event.turnId,
      role: 'agent',
      content: event.content,
      createdAt: event.timestamp,
      ...(toolCalls !== undefined && toolCalls.length > 0 ? { toolCalls } : {}),
      ...(event.isError === true ? { status: 'failed' as const } : {}),
    };
  });
}
