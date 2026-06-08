import type { InstanceEvent } from '@intx/hub-client';
import type { ChatMessage, ToolCall } from '@workbench/chat';

function stripContextBlock(content: string): string {
  return content.replace(/^<context>[\s\S]*?<\/context>\n*/u, '');
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
 */
export function convertInstanceEvents(events: InstanceEvent[]): ChatMessage[] {
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
      name: tc.name,
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
