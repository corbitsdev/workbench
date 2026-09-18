// Chats are mail threads. One chat has exactly one agent, and both sides
// of it are durable mail: the person sends from their own mailbox
// (`POST /mailbox/me/inbox/send`), which keeps a Sent copy and hands the
// frame to the hub, and the agent's reply lands in the same mailbox's
// INBOX. This file is the only seam between the chat UI and that surface —
// nothing here touches a chat-specific hub route, because none exist.
//
// A chat is identified by its agent's run id: the run is the conversation,
// and every message in the chat carries that run address on one side.

import { type } from "arktype";

import { listTopLevelRuns } from "../agents-api";
import { MYRA_SOURCE_CONFIG } from "../myra-source";

export class ChatApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ChatApiError";
  }
}

export type ChatAgent = {
  /** The deployment's anchor run id — what a message is addressed to. */
  readonly runId: string;
  readonly address: string;
  readonly name: string;
};

export type ChatMessage = {
  readonly id: string;
  readonly author: "me" | "agent";
  readonly authorName: string;
  readonly body: string;
  readonly at: string;
};

export type ChatSummary = {
  /** Route id: the agent's run id. */
  readonly id: string;
  readonly title: string;
  readonly agentName: string;
  readonly preview: string;
  readonly lastActivityAt: string;
};

/** Myra is the one default agent; her deploy asset name is not a display
 * name anyone should have to read. */
function displayAgentName(definitionName: string): string {
  return definitionName === MYRA_SOURCE_CONFIG.assetName
    ? MYRA_SOURCE_CONFIG.displayName
    : definitionName;
}

export function agentInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => word[0] ?? "");
  return (letters.join("") || "?").toUpperCase();
}

/** Every deployed agent the person can start a chat with. The stock run
 * listing already excludes non-top-level runs, so each row here is a real
 * deployment with a routable address. */
export async function listChatAgents(tenantId: string): Promise<readonly ChatAgent[]> {
  const runs = await listTopLevelRuns(tenantId);
  return runs
    .filter((run) => run.address.length > 0 && run.status !== "stopped")
    .map((run) => ({
      runId: run.id,
      address: run.address,
      name: displayAgentName(run.definitionName),
    }));
}

/** The agent an `@name` first message picks, matched case-insensitively
 * against the agent's display name with spaces removed. */
export function agentFromMention(
  text: string,
  agents: readonly ChatAgent[],
): ChatAgent | undefined {
  const mention = /(?:^|\s)@([\w-]+)/.exec(text)?.[1]?.toLowerCase();
  if (mention === undefined) return undefined;
  return agents.find((agent) => agent.name.toLowerCase().replace(/\s+/g, "") === mention);
}

// ---------------------------------------------------------------------
// Mailbox reads
// ---------------------------------------------------------------------

function mailboxPath(tenantId: string): string {
  return `/api/tenants/${encodeURIComponent(tenantId)}/mailbox/me/inbox`;
}

const Envelope = type({
  messageId: "string",
  from: "string",
  to: "string[]",
  subject: "string",
  date: "string",
  "inReplyTo?": "string",
  references: "string[]",
});

const InboxPage = type({
  messages: type({ uid: "number", envelope: Envelope, raw: "string" }).array(),
});

async function getJson<T>(path: string, schema: (value: unknown) => T | type.errors): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { accept: "application/json" } });
  } catch (cause) {
    throw new ChatApiError(cause instanceof Error ? cause.message : String(cause));
  }
  if (!response.ok) {
    throw new ChatApiError(`The server answered ${String(response.status)}.`, response.status);
  }
  const parsed = schema(await response.json().catch(() => undefined));
  if (parsed instanceof type.errors) {
    throw new ChatApiError(`Unexpected response shape from ${path}: ${parsed.summary}`);
  }
  return parsed;
}

/** The readable text of an RFC 5322 frame: the bytes after the header
 * section, or the first `text/plain` part of a multipart one. */
export function frameBody(raw: string): string {
  let decoded: string;
  try {
    decoded = atob(raw);
  } catch {
    return "";
  }
  return textPart(decoded.replace(/\r\n/g, "\n")) ?? "";
}

/** First `text/plain` leaf of a MIME entity, descending nested multiparts
 * (an agent reply is `multipart/signed` around `multipart/mixed`). The
 * boundary is matched case-sensitively: it is a token, not a header name. */
function textPart(entity: string): string | undefined {
  const split = entity.indexOf("\n\n");
  if (split < 0) return undefined;
  const headers = entity.slice(0, split);
  const body = entity.slice(split + 2);
  const boundary = /boundary="?([^";\n]+)"?/i.exec(headers)?.[1];
  if (boundary === undefined) {
    return /content-type:\s*text\/plain/i.test(headers) || !/content-type:/i.test(headers)
      ? body.trim()
      : undefined;
  }
  for (const part of body.split(`--${boundary}`).slice(1)) {
    if (part.startsWith("--")) break;
    const found = textPart(part.replace(/^\n/, ""));
    if (found !== undefined) return found;
  }
  return undefined;
}

function addressRunId(address: string): string | undefined {
  const local = address.split("@")[0]?.trim().replace(/^.*</, "");
  return local !== undefined && local.startsWith("run_") ? local : undefined;
}

type MailTurn = {
  readonly id: string;
  readonly messageId: string;
  readonly runId: string;
  readonly author: "me" | "agent";
  readonly subject: string;
  readonly body: string;
  readonly at: string;
};

/** Every chat turn in one folder: the person's own in `Sent`, the agents'
 * in `INBOX`. A message with no run address on either side is not a chat
 * turn and is dropped. */
async function readFolder(tenantId: string, folder: "INBOX" | "Sent"): Promise<MailTurn[]> {
  const page = await getJson(`${mailboxPath(tenantId)}?folder=${folder}&limit=100`, InboxPage);
  return page.messages.flatMap((message) => {
    const runId = [message.envelope.from, ...message.envelope.to]
      .map(addressRunId)
      .find((candidate) => candidate !== undefined);
    if (runId === undefined) return [];
    return [
      {
        id: `${folder}:${String(message.uid)}`,
        messageId: message.envelope.messageId,
        runId,
        author: folder === "Sent" ? ("me" as const) : ("agent" as const),
        subject: message.envelope.subject,
        body: frameBody(message.raw),
        at: message.envelope.date,
      },
    ];
  });
}

async function readTurns(tenantId: string): Promise<MailTurn[]> {
  const [inbox, sent] = await Promise.all([
    readFolder(tenantId, "INBOX"),
    readFolder(tenantId, "Sent"),
  ]);
  return [...inbox, ...sent].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// ---------------------------------------------------------------------
// Sends
// ---------------------------------------------------------------------

const SendAccepted = type({ messageId: "string", uid: "number" });

async function sendToAgent(
  tenantId: string,
  agent: ChatAgent,
  body: string,
  inReplyTo: string | undefined,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${mailboxPath(tenantId)}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: [agent.address],
        subject: body.slice(0, 60),
        body,
        ...(inReplyTo !== undefined ? { inReplyTo } : {}),
      }),
    });
  } catch (cause) {
    throw new ChatApiError(cause instanceof Error ? cause.message : String(cause));
  }
  if (!response.ok) {
    throw new ChatApiError(
      `The agent could not be reached (${String(response.status)}).`,
      response.status,
    );
  }
  const parsed = SendAccepted(await response.json().catch(() => undefined));
  if (parsed instanceof type.errors) {
    throw new ChatApiError(`Unexpected send response: ${parsed.summary}`);
  }
}

/** Starts a chat with one agent. Returns the chat id to route to — the
 * agent's run id, which the Sent copy already carries. */
export async function startChat(
  tenantId: string,
  agent: ChatAgent,
  content: string,
): Promise<string> {
  await sendToAgent(tenantId, agent, content, undefined);
  return agent.runId;
}

/** A reply is the same send, threaded onto the chat's newest message. */
export async function replyInChat(
  tenantId: string,
  chat: ChatThread,
  content: string,
): Promise<void> {
  await sendToAgent(tenantId, chat.agent, content, chat.lastMessageId);
}

// ---------------------------------------------------------------------
// Chat listing and reads
// ---------------------------------------------------------------------

export type ChatThread = {
  readonly id: string;
  readonly title: string;
  readonly agentName: string;
  readonly agent: ChatAgent;
  /** The newest turn's Message-ID: what the next reply threads onto. */
  readonly lastMessageId: string | undefined;
  readonly messages: readonly ChatMessage[];
};

function chatTitle(turns: readonly MailTurn[], agentName: string): string {
  const first = turns[0];
  if (first === undefined) return agentName;
  return first.subject.length > 0 ? first.subject : first.body.slice(0, 60);
}

/** Every chat the person has: one per agent they have exchanged mail
 * with. */
export async function listChats(tenantId: string): Promise<readonly ChatSummary[]> {
  const [agents, turns] = await Promise.all([listChatAgents(tenantId), readTurns(tenantId)]);
  const byRun = new Map<string, MailTurn[]>();
  for (const turn of turns) {
    byRun.set(turn.runId, [...(byRun.get(turn.runId) ?? []), turn]);
  }
  return [...byRun.entries()]
    .map(([runId, rows]) => {
      const agentName = agents.find((agent) => agent.runId === runId)?.name ?? runId;
      const newest = rows[rows.length - 1]!;
      return {
        id: runId,
        title: chatTitle(rows, agentName),
        agentName,
        preview: newest.body.slice(0, 80),
        lastActivityAt: newest.at,
      };
    })
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
}

/** One chat's full transcript: every mail turn on that agent's run,
 * oldest first. */
export async function readChat(tenantId: string, chatId: string): Promise<ChatThread> {
  const [agents, turns] = await Promise.all([listChatAgents(tenantId), readTurns(tenantId)]);
  const agent = agents.find((candidate) => candidate.runId === chatId);
  if (agent === undefined) {
    throw new ChatApiError("That agent is no longer deployed.", 404);
  }
  const rows = turns.filter((turn) => turn.runId === chatId);
  return {
    id: chatId,
    title: chatTitle(rows, agent.name),
    agentName: agent.name,
    agent,
    lastMessageId: rows[rows.length - 1]?.messageId,
    messages: rows.map((turn) => ({
      id: turn.id,
      author: turn.author,
      authorName: turn.author === "me" ? "You" : agent.name,
      body: turn.body,
      at: turn.at,
    })),
  };
}

/** Live mailbox updates. The stream carries no chat identity, so a caller
 * refetches on any event rather than patching a thread in place. */
export function subscribeToInbox(tenantId: string, onChange: () => void): () => void {
  const source = new EventSource(`${mailboxPath(tenantId)}/events`);
  const handler = () => onChange();
  source.addEventListener("message", handler);
  return () => {
    source.removeEventListener("message", handler);
    source.close();
  };
}

// ---------------------------------------------------------------------
// Rooms: a workbench is a child tenant, and its room conversation is that
// tenant's mailbox. Reads are the same stock mailbox routes as a chat,
// scoped to the child tenant id; participants are the child tenant's
// principals.
// ---------------------------------------------------------------------

export type RoomParticipant = {
  readonly id: string;
  readonly kind: "person" | "agent";
  readonly name: string;
  readonly address: string;
  /** Present for agents: the deployment's anchor run, what a send is
   * addressed to. */
  readonly runId?: string;
};

const PrincipalPage = type({
  data: type({
    id: "string",
    kind: "string",
    refId: "string",
    displayName: "string",
    "email?": "string",
    status: "string",
  }).array(),
  nextCursor: "string | null",
});

/** Everyone in the room: the child tenant's principals plus its live
 * deployments' run addresses. A deployment's workflow principal only
 * appears after its first run, so the run listing is what makes an agent
 * addressable from the moment it is deployed into the room. */
export async function listRoomParticipants(tenantId: string): Promise<readonly RoomParticipant[]> {
  const [page, runs] = await Promise.all([
    getJson(`/api/tenants/${encodeURIComponent(tenantId)}/principals?limit=100`, PrincipalPage),
    listChatAgents(tenantId),
  ]);
  const people = page.data
    .filter((principal) => principal.status !== "removed" && principal.kind === "user")
    .map((principal): RoomParticipant => ({
      id: principal.id,
      kind: "person",
      name: principal.displayName,
      address: principal.email ?? principal.refId,
    }));
  const agents = runs.map((run): RoomParticipant => ({
    id: run.runId,
    kind: "agent",
    name: run.name,
    address: run.address,
    runId: run.runId,
  }));
  return [...people, ...agents];
}

export type RoomMessage = {
  readonly id: string;
  /** The turn's Message-ID: what a reply in its sub-thread threads onto. */
  readonly messageId: string;
  readonly author: "me" | "other";
  readonly authorName: string;
  readonly body: string;
  readonly at: string;
  /** Native in-reply-to children: the room's sub-threads. */
  readonly replies: readonly RoomMessage[];
};

function authorName(address: string): string {
  const local = address.split("@")[0]?.replace(/^.*</, "") ?? address;
  return local.length > 0 ? local : address;
}

type RoomTurn = {
  readonly id: string;
  readonly messageId: string;
  readonly parentId: string | undefined;
  readonly author: "me" | "other";
  readonly authorName: string;
  readonly body: string;
  readonly at: string;
};

/** One folder of the room mailbox: the person's own turns live in `Sent`,
 * everyone else's in `INBOX`. Unlike a chat, a room keeps every message —
 * a person-to-person turn is as much part of the room as an agent's. */
async function readRoomFolder(tenantId: string, folder: "INBOX" | "Sent"): Promise<RoomTurn[]> {
  const page = await getJson(`${mailboxPath(tenantId)}?folder=${folder}&limit=100`, InboxPage);
  return page.messages.map((message) => ({
    id: `${folder}:${String(message.uid)}`,
    messageId: message.envelope.messageId,
    parentId: message.envelope.inReplyTo ?? message.envelope.references.at(-1),
    author: folder === "Sent" ? ("me" as const) : ("other" as const),
    authorName: folder === "Sent" ? "You" : authorName(message.envelope.from),
    body: frameBody(message.raw),
    at: message.envelope.date,
  }));
}

/** The room timeline: every root turn oldest first, its in-reply-to chain
 * nested beneath it as the room's sub-threads. */
export async function readRoom(tenantId: string): Promise<readonly RoomMessage[]> {
  const [inbox, sent] = await Promise.all([
    readRoomFolder(tenantId, "INBOX"),
    readRoomFolder(tenantId, "Sent"),
  ]);
  const turns = [...inbox, ...sent].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const known = new Set(turns.map((turn) => turn.messageId));
  const children = new Map<string, RoomTurn[]>();
  const roots: RoomTurn[] = [];
  for (const turn of turns) {
    const parentId = turn.parentId;
    if (parentId === undefined || !known.has(parentId)) {
      roots.push(turn);
      continue;
    }
    children.set(parentId, [...(children.get(parentId) ?? []), turn]);
  }
  const build = (turn: RoomTurn): RoomMessage => ({
    id: turn.id,
    messageId: turn.messageId,
    author: turn.author,
    authorName: turn.authorName,
    body: turn.body,
    at: turn.at,
    replies: (children.get(turn.messageId) ?? []).map(build),
  });
  return roots.map(build);
}

/** The one send seam for a room: a single mailbox send addressed to every
 * agent in it. The hub triggers each addressed run and keeps the Sent
 * copy, so the person's own turn comes back out of the mailbox like any
 * other. */
export async function sendToRoom(input: {
  readonly roomTenantId: string;
  readonly agents: readonly RoomParticipant[];
  readonly content: string;
  /** The turn this reply threads onto — a sub-thread's parent. */
  readonly inReplyTo?: string;
}): Promise<void> {
  const to = input.agents.map((agent) => agent.address).filter((address) => address.includes("@"));
  if (to.length === 0) {
    throw new ChatApiError("No agent is in this workbench yet, so there is nobody to send to.");
  }
  let response: Response;
  try {
    response = await fetch(`${mailboxPath(input.roomTenantId)}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to,
        subject: input.content.slice(0, 60),
        body: input.content,
        ...(input.inReplyTo !== undefined ? { inReplyTo: input.inReplyTo } : {}),
      }),
    });
  } catch (cause) {
    throw new ChatApiError(cause instanceof Error ? cause.message : String(cause));
  }
  if (!response.ok) {
    throw new ChatApiError(
      `The workbench could not be reached (${String(response.status)}).`,
      response.status,
    );
  }
  const parsed = SendAccepted(await response.json().catch(() => undefined));
  if (parsed instanceof type.errors) {
    throw new ChatApiError(`Unexpected send response: ${parsed.summary}`);
  }
}
