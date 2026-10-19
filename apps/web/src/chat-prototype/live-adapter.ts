// Maps a workbench's real mailbox onto the chat's message model, so the
// stateless components render live data exactly as they render fixtures.
// Pure functions only: reading, sending and refreshing live in the hook.

import { stripNameLine } from "@/bench/worker-name";
import {
  sameAddress,
  type MailAttachment,
  type WorkbenchMessage,
  type WorkbenchParticipant,
} from "@/chat/threads-api";
import { stripRoster } from "@/chat/workbench-roster";

import type { ChatMessage, ChatPart, FilePart, Participant, TimelineEntry } from "./model";

/** The participant id your own messages carry. */
export const LIVE_ME_ID = "me";

/** The start of a text attachment shown on hover. */
const EXCERPT_CHARS = 280;

/** Clocks differ between the browser and the mailbox; an echo stamped a
 * little before the send still settles it. */
const ECHO_TOLERANCE_MS = 60_000;

export type LiveConversation = {
  readonly entries: readonly TimelineEntry[];
  /** The roster as chat participants, plus anyone who wrote in from
   * outside it. */
  readonly participants: readonly Participant[];
};

/** A message you sent that the mailbox hasn't echoed back yet. */
export type PendingSend = {
  readonly id: string;
  readonly text: string;
  readonly at: string;
  readonly threadId?: string;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isTextLike(mediaType: string): boolean {
  return mediaType.startsWith("text/") || mediaType === "application/json";
}

function filePart(attachment: MailAttachment): FilePart {
  const part: FilePart = {
    type: "file",
    name: attachment.name,
    mediaType: attachment.contentType,
    size: formatBytes(new TextEncoder().encode(attachment.text).length),
  };
  return isTextLike(attachment.contentType)
    ? { ...part, excerpt: attachment.text.slice(0, EXCERPT_CHARS) }
    : part;
}

function outsiderId(address: string): string {
  return `address:${address.toLowerCase()}`;
}

/** Who wrote a message: you, a roster member by address, the bench's only
 * agent when a restarted run's address no longer matches, or an outsider. */
function authorOf(
  message: WorkbenchMessage,
  roster: readonly WorkbenchParticipant[],
): WorkbenchParticipant | "me" | undefined {
  if (message.author === "me") return "me";
  const matched = roster.find((participant) => sameAddress(participant.address, message.address));
  if (matched !== undefined) return matched;
  const agents = roster.filter((participant) => participant.kind === "agent");
  return agents.length === 1 ? agents[0] : undefined;
}

/** What a person reads: no roster block on your own sends, no `Name:`
 * line on an agent's replies. */
function readableBody(
  message: WorkbenchMessage,
  author: WorkbenchParticipant | "me" | undefined,
): string {
  if (author === "me") return stripRoster(message.body).trim();
  if (author?.kind === "agent") return stripNameLine(message.body).trim();
  return message.body.trim();
}

export function liveConversation(
  messages: readonly WorkbenchMessage[],
  roster: readonly WorkbenchParticipant[],
): LiveConversation {
  const outsiders = new Map<string, Participant>();
  const idByMessageId = new Map(messages.map((message) => [message.messageId, message.id]));

  const mapped = messages.map((message): ChatMessage => {
    const author = authorOf(message, roster);
    let authorId: string;
    if (author === "me") {
      authorId = LIVE_ME_ID;
    } else if (author !== undefined) {
      authorId = author.id;
    } else {
      authorId = outsiderId(message.address);
      outsiders.set(authorId, { id: authorId, kind: "person", name: message.authorName });
    }
    const body = readableBody(message, author);
    // Files lead, then what was said about them.
    const parts: ChatPart[] = [
      ...message.attachments.map(filePart),
      ...(body === "" ? [] : [{ type: "text" as const, text: body }]),
    ];
    const parentId =
      message.parentMessageId === undefined
        ? undefined
        : idByMessageId.get(message.parentMessageId);
    return {
      type: "message",
      id: message.id,
      authorId,
      at: message.at,
      parts,
      status: "sent",
      ...(parentId === undefined ? {} : { threadId: parentId }),
    };
  });

  // The server would send a reply count with the parent; the mailbox doesn't,
  // so it's counted here.
  const replies = new Map<string, { count: number; lastAt: string }>();
  for (const message of mapped) {
    if (message.threadId === undefined) continue;
    const summary = replies.get(message.threadId) ?? { count: 0, lastAt: message.at };
    replies.set(message.threadId, {
      count: summary.count + 1,
      lastAt: Date.parse(message.at) > Date.parse(summary.lastAt) ? message.at : summary.lastAt,
    });
  }
  const entries = mapped.map((message) => {
    const thread = replies.get(message.id);
    return thread === undefined ? message : { ...message, thread };
  });

  const participants: Participant[] = [
    ...roster.map((participant): Participant => ({
      id: participant.id,
      kind: participant.kind,
      name: participant.name,
    })),
    ...outsiders.values(),
  ];
  return { entries, participants };
}

function ownText(message: ChatMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
}

/** The sends the mailbox hasn't echoed back yet: no own message with the
 * same text from around the time it was sent. */
export function unsettledSends(
  entries: readonly TimelineEntry[],
  pending: readonly PendingSend[],
): readonly PendingSend[] {
  const own = entries.filter(
    (entry): entry is ChatMessage => entry.type === "message" && entry.authorId === LIVE_ME_ID,
  );
  return pending.filter(
    (send) =>
      !own.some(
        (message) =>
          ownText(message) === send.text.trim() &&
          Date.parse(message.at) >= Date.parse(send.at) - ECHO_TOLERANCE_MS,
      ),
  );
}
