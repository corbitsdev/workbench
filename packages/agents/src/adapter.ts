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

function isAgentInstanceEmail(email: string): boolean {
  const atIndex = email.indexOf('@');
  const localPart = atIndex > 0 ? email.slice(0, atIndex) : email;
  return localPart.startsWith('ins_');
}

function resolveSenderLabel(sender: { name: string | null; email: string }): string {
  if (sender.name !== null && sender.name.trim() !== '') {
    return sender.name.trim();
  }
  const atIndex = sender.email.indexOf('@');
  if (atIndex > 0) {
    return sender.email.slice(0, atIndex);
  }
  return sender.email;
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
  // Pure mapping — ordering is owned by composeChatMessages, which preserves the
  // events' arrival order (hydration sorts by server timestamp; live events are
  // appended). Keeping this a 1:1 map means callers that bypass composeChatMessages
  // get events in source order.
  return events.map((event): ChatMessage => {
    if (event.kind === 'mail') {
      const isInbound = event.role === 'user';
      const isAgentToAgent = isInbound && isAgentInstanceEmail(event.sender.email);
      const senderLabel = isAgentToAgent ? resolveSenderLabel(event.sender) : undefined;
      return {
        id: event.id,
        role: isAgentToAgent ? 'agent' : isInbound ? 'user' : 'agent',
        content: isInbound ? stripContextBlock(event.content) : event.content,
        createdAt: event.timestamp,
        ...(senderLabel !== undefined && senderLabel !== '' ? { senderLabel } : {}),
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
