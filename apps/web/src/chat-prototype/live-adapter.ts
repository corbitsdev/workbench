// Maps a workbench's real mailbox onto the chat's message model, so the
// stateless components render live data exactly as they render fixtures.
// Pure functions only: reading, sending and refreshing live in the hook.

import type { Approval } from "@/api";
import { stripNameLine } from "@/bench/worker-name";
import {
  sameAddress,
  type MailAttachment,
  type WorkbenchFolder,
  type WorkbenchMessage,
  type WorkbenchParticipant,
  type WorkbenchTurn,
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

/** A roster member by address, or the bench's only agent when a restarted
 * run's address no longer matches. */
function participantAt(
  address: string,
  roster: readonly WorkbenchParticipant[],
): WorkbenchParticipant | undefined {
  const matched = roster.find((participant) => sameAddress(participant.address, address));
  if (matched !== undefined) return matched;
  const agents = roster.filter((participant) => participant.kind === "agent");
  return agents.length === 1 ? agents[0] : undefined;
}

/** Who wrote a message: you, someone on the roster, or an outsider. */
function authorOf(
  message: WorkbenchMessage,
  roster: readonly WorkbenchParticipant[],
): WorkbenchParticipant | "me" | undefined {
  return message.author === "me" ? "me" : participantAt(message.address, roster);
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

/** What a run reports about its current turn. */
export type RuntimeStatus = "idle" | "busy" | "waiting_approval";

/** What the chat shows for the worker. */
export type WorkerActivity = "idle" | "working" | "needs-you";

/** The worker's state from the run's own status where the hub has one, and
 * from "you sent and nobody answered yet" where it doesn't. Just after a
 * send the run can still read idle until it picks the message up, so idle
 * only ends the wait once the run has been busy since the send. */
export function workerActivity(input: {
  readonly runtimeStatus: RuntimeStatus | undefined;
  readonly waitingOnReply: boolean;
  readonly busySinceSend: boolean;
}): WorkerActivity {
  if (input.runtimeStatus === "waiting_approval") return "needs-you";
  if (input.runtimeStatus === "busy") return "working";
  if (!input.waitingOnReply) return "idle";
  return input.runtimeStatus === "idle" && input.busySinceSend ? "idle" : "working";
}

/** The longest a card's summary or argument line runs before it's cut. */
const CARD_LINE_CHARS = 160;

function clip(text: string): string {
  return text.length <= CARD_LINE_CHARS ? text : `${text.slice(0, CARD_LINE_CHARS - 1)}…`;
}

/** What the tool says it does, first sentence only. */
function toolSummary(definition: Approval["toolDefinition"], name: string): string {
  const description =
    typeof definition["description"] === "string" ? definition["description"] : "";
  const first = /^.*?[.!?](?=\s|$)/.exec(description.trim())?.[0] ?? description.trim();
  return first === "" ? `${name} wants to run.` : clip(first);
}

/** The call's arguments as one readable line. */
function argumentLine(args: Approval["toolArguments"]): string {
  return clip(
    Object.entries(args)
      .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(", "),
  );
}

/** Pending approvals as cards from the agent that asked, placed when it
 * asked. Decided ones are already reflected in what the agent did next. */
export function liveApprovals(
  approvals: readonly Approval[],
  roster: readonly WorkbenchParticipant[],
): readonly ChatMessage[] {
  return approvals
    .filter((approval) => approval.status === "pending")
    .map((approval): ChatMessage => {
      const definition = approval.toolDefinition;
      const name = typeof definition["name"] === "string" ? definition["name"] : "a tool";
      return {
        type: "message",
        id: `approval:${approval.id}`,
        authorId:
          participantAt(approval.agentAddress, roster)?.id ?? outsiderId(approval.agentAddress),
        at: approval.createdAt,
        status: "sent",
        parts: [
          {
            type: "approval",
            id: approval.id,
            tool: name,
            summary: toolSummary(definition, name),
            scope: argumentLine(approval.toolArguments),
            decision: null,
          },
        ],
      };
    });
}

/** What has been read of one mailbox folder so far. */
export type FolderHistory = {
  readonly turns: readonly WorkbenchTurn[];
  /** Read back to its first message. */
  readonly complete: boolean;
};

export type MergedHistory = {
  /** Everything safe to show: in order, with nothing missing in between. */
  readonly turns: readonly WorkbenchTurn[];
  readonly hasEarlier: boolean;
  /** The folder to read further back next, or null when both are done. */
  readonly behind: WorkbenchFolder | null;
};

function oldest(turns: readonly WorkbenchTurn[]): number {
  return Math.min(...turns.map((turn) => Date.parse(turn.at)));
}

/** A conversation spans two folders, each paged back on its own. A message
 * older than where an unfinished folder has been read to could have
 * neighbours in that folder still unread, so it waits until that folder
 * catches up. The folder holding the line is the one to read next. */
export function mergeFolders(inbox: FolderHistory, sent: FolderHistory): MergedHistory {
  const unfinished = (
    [
      ["INBOX", inbox],
      ["Sent", sent],
    ] as const
  ).filter(([, folder]) => !folder.complete && folder.turns.length > 0);
  let behind: WorkbenchFolder | null = null;
  let line = -Infinity;
  for (const [name, folder] of unfinished) {
    const reached = oldest(folder.turns);
    if (reached > line) {
      line = reached;
      behind = name;
    }
  }
  const shown = (turns: readonly WorkbenchTurn[]) =>
    turns.filter((turn) => Date.parse(turn.at) >= line);
  return {
    turns: [...shown(inbox.turns), ...shown(sent.turns)],
    hasEarlier: behind !== null,
    behind,
  };
}
