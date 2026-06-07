import { type ChatMessage } from './types';

/**
 * A single visible message in the compacted view.
 */
export interface MessageItem {
  type: 'message';
  message: ChatMessage;
}

/**
 * A collapsed group of tool messages that can be expanded.
 */
export interface CollapsedGroupItem {
  type: 'collapsed_group';
  /** Stable key derived from the first message ID in the group. */
  id: string;
  /** How many messages are in this group. */
  count: number;
  /** The collapsed messages, available when expanded. */
  messages: ChatMessage[];
}

export type CompactedItem = MessageItem | CollapsedGroupItem;

/**
 * Returns true if a message is protected from compaction — it must always
 * remain fully visible regardless of thread length.
 */
function isProtected(message: ChatMessage): boolean {
  // User messages are never collapsed.
  if (message.role === 'user') return true;
  // Error/failed messages are never collapsed.
  if (message.status === 'failed') return true;
  // Artifact messages (final outputs) are never collapsed.
  if (message.kind === 'artifact') return true;
  return false;
}

/**
 * Returns true if a message is a candidate for compaction (tool activity).
 */
function isCompactable(message: ChatMessage): boolean {
  if (isProtected(message)) return false;
  return message.kind === 'tool';
}

/**
 * Compact a flat message list into a mixed list of visible messages and
 * collapsed groups.
 *
 * Rules:
 * - When `messages.length <= threshold`, no compaction occurs.
 * - The most recent `recentWindow` messages are always fully visible.
 * - Outside that window, consecutive runs of compactable (tool) messages are
 *   collapsed into a single `CollapsedGroupItem`.
 * - User messages, failed messages, and artifact messages are never collapsed.
 *
 * @param messages   Flat ordered message list (oldest first).
 * @param threshold  Minimum message count before compaction kicks in. Default 10.
 * @param recentWindow  How many tail messages are always fully visible. Default 5.
 */
export function compactMessages(
  messages: ChatMessage[],
  threshold = 10,
  recentWindow = 5
): CompactedItem[] {
  if (threshold <= 0 || messages.length <= threshold) {
    return messages.map((message) => ({ type: 'message', message }));
  }

  // The tail is always shown in full.
  const tailStart = Math.max(0, messages.length - recentWindow);
  const head = messages.slice(0, tailStart);
  const tail = messages.slice(tailStart);

  const result: CompactedItem[] = [];

  // Process the head: group consecutive compactable runs.
  let groupBuffer: ChatMessage[] = [];

  function flushGroup() {
    if (groupBuffer.length === 0) return;
    if (groupBuffer.length === 1) {
      // Single-item groups don't add value; show the message directly.
      result.push({ type: 'message', message: groupBuffer[0] as ChatMessage });
    } else {
      result.push({
        type: 'collapsed_group',
        id: groupBuffer[0]?.id ?? 'group',
        count: groupBuffer.length,
        messages: [...groupBuffer],
      });
    }
    groupBuffer = [];
  }

  for (const message of head) {
    if (isCompactable(message)) {
      groupBuffer.push(message);
    } else {
      flushGroup();
      result.push({ type: 'message', message });
    }
  }
  flushGroup();

  // Append the tail fully.
  for (const message of tail) {
    result.push({ type: 'message', message });
  }

  return result;
}
