// Pure adapter from a mailbox thread read (`@corbits/mailbox`'s
// `MailboxThreadMessage`) onto the timeline item shape `use-workbench-feed.ts`
// already produces (CL-8174 slice 2a). No new wire shape: a mail message
// becomes exactly the `MessageItem` the rest of chat-ui already knows how to
// render, so the timeline never has to branch on where a message came from.

import type { MailboxRef, MailboxThreadMessage } from "@corbits/mailbox";
import type { MessageItem } from "./api";

/** The timeline item shape — an alias, not a new type, so a mail-derived
 * row and a chat-native row are interchangeable everywhere the timeline
 * already consumes `MessageItem`. */
export type TimelineItem = MessageItem;

/**
 * Maps one mailbox thread's messages onto timeline items.
 *
 * `subject`, when present, prefixes the body as its own line — mail is the
 * only source that carries a subject, so it is folded into the one text
 * part a `MessageItem` has room for rather than inventing a field the rest
 * of chat-ui would have to learn about.
 *
 * `threadId` links a reply to its parent's own `id` (not its `messageId`,
 * which is the RFC-2822-style id the `inReplyTo`/`references` headers
 * carry) by resolving `inReplyTo` against every message's `messageId` in
 * this same batch. A message whose parent isn't in this batch — the root,
 * or a reply to a message this read didn't page in — keeps `threadId`
 * absent rather than guessing.
 */
export function threadMessagesToTimeline(
  messages: readonly MailboxThreadMessage[],
): TimelineItem[] {
  const idByMessageId = new Map<string, string>();
  for (const message of messages) {
    idByMessageId.set(message.messageId, message.id);
  }

  return messages.map((message) => {
    const parentId =
      message.inReplyTo !== undefined
        ? idByMessageId.get(message.inReplyTo)
        : undefined;
    const text =
      message.subject !== undefined && message.subject.length > 0
        ? `${message.subject}\n${message.body}`
        : message.body;
    return {
      id: message.id,
      createdAt: message.createdAt,
      parts: [{ kind: "text", text }],
      sender: { name: null, address: message.fromAddress },
      ...(parentId !== undefined ? { threadId: parentId } : {}),
    };
  });
}

/**
 * The same `{ kind: "workbench", id }` ref every mailbox writer stamps
 * (`apps/hub/src/mailbox-persist.ts`'s `hubMailboxResolveRefs`,
 * `packages/chat/src/mailbox-fanout.ts`'s `writeChatMailboxFanout`) — a
 * workbench is a plain tenant now (CL-8083), so the room a thread hangs
 * off is the same id a chat room is scoped to, and `tenantId` is carried
 * here only so a caller with just a tenant in hand has a matching call
 * shape; the stamped ref itself never varies by which of the two identical
 * ids produced it.
 */
export function roomRefFor(_tenantId: string, roomId: string): MailboxRef {
  return { kind: "workbench", id: roomId };
}
