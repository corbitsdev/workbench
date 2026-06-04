import type { InstanceEvent } from '@intx/hub-client';
import type { ChatMessage } from '@workbench/chat';

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
  return events.map((event): ChatMessage => {
    if (event.kind === 'mail') {
      return {
        id: event.id,
        role: event.role === 'user' ? 'user' : 'agent',
        content: event.content,
        createdAt: event.timestamp,
        ...(event.isError === true ? { status: 'failed' as const } : {}),
      };
    }

    // kind === "turn"
    return {
      id: event.turnId,
      role: 'agent',
      content: event.content,
      createdAt: event.timestamp,
      ...(event.isError === true ? { status: 'failed' as const } : {}),
    };
  });
}
