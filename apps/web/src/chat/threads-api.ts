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
  const text = decoded.replace(/\r\n/g, "\n");
  const split = text.indexOf("\n\n");
  if (split < 0) return "";
  const headers = text.slice(0, split).toLowerCase();
  const body = text.slice(split + 2);
  const boundary = /boundary="?([^";\n]+)"?/.exec(headers)?.[1];
  if (boundary === undefined) return body.trim();
  for (const part of body.split(`--${boundary}`)) {
    const partSplit = part.indexOf("\n\n");
    if (partSplit < 0) continue;
    if (!part.slice(0, partSplit).toLowerCase().includes("text/plain")) continue;
    return part.slice(partSplit + 2).trim();
  }
  return "";
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
