// Chats are mail threads. One chat has exactly one agent, and both sides
// of it are durable mail: the person sends from their own mailbox
// (`POST /mailbox/me/inbox/send`), which keeps a Sent copy and hands the
// frame to the hub, and the agent's reply lands in the same mailbox's
// INBOX. This file is the only seam between the chat UI and that surface —
// nothing here touches a chat-specific hub route, because none exist.
//
// A chat is identified by its agent's definition asset id, not a run id —
// every hub restart releases the old run and redeploys under a new one, so
// keying on a run id would 409 the moment it turns terminal. An agent's
// address set spans every run it has ever had (releases included), which is
// what keeps a chat's history intact across a redeploy; sends resolve the
// current live run's address at send time.

import { type } from "arktype";
import { WorkflowDeploymentResponse } from "@intx/types";

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
  /** Route/chat id: the agent's definition asset id — stable across
   * redeploys, unlike a run id. */
  readonly id: string;
  readonly name: string;
  /** The workflow asset's raw name — what its source is pushed at, e.g.
   * for re-reading a deploy source; `name` above may be a display alias. */
  readonly assetName: string;
  /** Every address this agent has ever run under, releases included. */
  readonly addresses: readonly string[];
  /** The address of the agent's currently live run, or null when none is
   * live (mid-redeploy). */
  readonly liveAddress: string | null;
};

const LIVE_DEPLOYMENT_STATUSES = new Set(["deployed", "pending", "recovering"]);

const DeploymentsSchema = WorkflowDeploymentResponse.array();
const WorkflowAssetSchema = type({ id: "string", name: "string" }).array();

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

/** Myra is always in a new workbench and never a pickable option. */
export function isMyraAgent(agent: Pick<ChatAgent, "assetName">): boolean {
  return agent.assetName === MYRA_SOURCE_CONFIG.assetName;
}

export function agentInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => word[0] ?? "");
  return (letters.join("") || "?").toUpperCase();
}

function deploymentsPath(tenantId: string): string {
  return `/api/tenants/${encodeURIComponent(tenantId)}/workflows/deployments`;
}

function workflowAssetsPath(tenantId: string): string {
  return `/api/tenants/${encodeURIComponent(tenantId)}/assets?kind=workflow&inherited=false`;
}

/** Every agent the person has ever had a deployment of, keyed by its
 * definition asset id. Deployments list every anchor run ever created for
 * an asset (releases included, most recent first), joined here against the
 * run listing for each run's address and against the workflow assets for a
 * display name. */
export async function listChatAgents(tenantId: string): Promise<readonly ChatAgent[]> {
  const [deployments, assets, runs] = await Promise.all([
    getJson(deploymentsPath(tenantId), DeploymentsSchema),
    getJson(workflowAssetsPath(tenantId), WorkflowAssetSchema),
    listTopLevelRuns(tenantId),
  ]);
  const addressByRunId = new Map(runs.map((run) => [run.id, run.address]));
  const nameByAssetId = new Map(assets.map((asset) => [asset.id, asset.name]));

  const byAsset = new Map<string, { addresses: Set<string>; liveAddress: string | null }>();
  for (const deployment of deployments) {
    const address = addressByRunId.get(deployment.id);
    if (address === undefined || address.length === 0) continue;
    const entry = byAsset.get(deployment.definitionAssetId) ?? {
      addresses: new Set<string>(),
      liveAddress: null,
    };
    entry.addresses.add(address);
    // Deployments come back newest-first, so the first live one seen per
    // asset is the current one.
    if (entry.liveAddress === null && LIVE_DEPLOYMENT_STATUSES.has(deployment.status)) {
      entry.liveAddress = address;
    }
    byAsset.set(deployment.definitionAssetId, entry);
  }

  return [...byAsset.entries()].map(([assetId, entry]) => {
    const assetName = nameByAssetId.get(assetId) ?? assetId;
    return {
      id: assetId,
      name: displayAgentName(assetName),
      assetName,
      addresses: [...entry.addresses],
      liveAddress: entry.liveAddress,
    };
  });
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

function extractAddress(raw: string): string {
  return (/<([^>]+)>/.exec(raw)?.[1] ?? raw).trim();
}

/** The run address on a message, from whichever side (from/to) carries
 * one — a plain address, not just its local part, so it can be matched
 * against an agent's full address set. */
function participantAddress(envelope: { from: string; to: readonly string[] }): string | undefined {
  return [envelope.from, ...envelope.to]
    .map(extractAddress)
    .find((address) => address.split("@")[0]?.startsWith("run_"));
}

type MailTurn = {
  readonly id: string;
  readonly messageId: string;
  readonly address: string;
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
    const address = participantAddress(message.envelope);
    if (address === undefined) return [];
    return [
      {
        id: `${folder}:${String(message.uid)}`,
        messageId: message.envelope.messageId,
        address,
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
  address: string,
  body: string,
  inReplyTo: string | undefined,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${mailboxPath(tenantId)}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: [address],
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
 * agent's definition asset id. Callers should keep the composer disabled
 * until `liveAddress` is set; this still guards against a stale click. */
export async function startChat(
  tenantId: string,
  agent: ChatAgent,
  content: string,
): Promise<string> {
  if (agent.liveAddress === null) {
    throw new ChatApiError(`${agent.name} is starting…`);
  }
  await sendToAgent(tenantId, agent.liveAddress, content, undefined);
  return agent.id;
}

/** A reply is the same send, threaded onto the chat's newest message, sent
 * to the agent's current live run — not whichever run last answered. */
export async function replyInChat(
  tenantId: string,
  chat: ChatThread,
  content: string,
): Promise<void> {
  if (chat.agent.liveAddress === null) {
    throw new ChatApiError(`${chat.agent.name} is starting…`);
  }
  await sendToAgent(tenantId, chat.agent.liveAddress, content, chat.lastMessageId);
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

function agentByAddress(agents: readonly ChatAgent[]): Map<string, ChatAgent> {
  const index = new Map<string, ChatAgent>();
  for (const agent of agents) {
    for (const address of agent.addresses) index.set(address, agent);
  }
  return index;
}

/** Every chat the person has: one per agent they have exchanged mail with,
 * grouped by the agent's asset id so a redeploy's new run still lands in
 * the same chat. */
export async function listChats(tenantId: string): Promise<readonly ChatSummary[]> {
  const [agents, turns] = await Promise.all([listChatAgents(tenantId), readTurns(tenantId)]);
  const addressToAgent = agentByAddress(agents);
  const byAgent = new Map<string, MailTurn[]>();
  for (const turn of turns) {
    const agent = addressToAgent.get(turn.address);
    if (agent === undefined) continue;
    byAgent.set(agent.id, [...(byAgent.get(agent.id) ?? []), turn]);
  }
  return [...byAgent.entries()]
    .map(([agentId, rows]) => {
      const agentName = agents.find((agent) => agent.id === agentId)?.name ?? agentId;
      const newest = rows[rows.length - 1]!;
      return {
        id: agentId,
        title: chatTitle(rows, agentName),
        agentName,
        preview: newest.body.slice(0, 80),
        lastActivityAt: newest.at,
      };
    })
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
}

/** One chat's full transcript: every mail turn addressed to any run this
 * agent has ever had, oldest first. */
export async function readChat(tenantId: string, chatId: string): Promise<ChatThread> {
  const [agents, turns] = await Promise.all([listChatAgents(tenantId), readTurns(tenantId)]);
  const agent = agents.find((candidate) => candidate.id === chatId);
  if (agent === undefined) {
    throw new ChatApiError("That agent could not be found.", 404);
  }
  const addresses = new Set(agent.addresses);
  const rows = turns.filter((turn) => addresses.has(turn.address));
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
  // The stream writes named `mailbox` frames; the default `message` event
  // never fires for those.
  source.addEventListener("mailbox", handler);
  return () => {
    source.removeEventListener("mailbox", handler);
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
  /** For an agent, its current live run's address — empty when none is
   * live, which `sendToRoom` filters out. */
  readonly address: string;
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
  const [page, chatAgents] = await Promise.all([
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
  const agents = chatAgents.map((agent): RoomParticipant => ({
    id: agent.id,
    kind: "agent",
    name: agent.name,
    address: agent.liveAddress ?? "",
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
  /** In-reply-to parent, when this turn named one and it matched a known
   * message — metadata for the sub-thread panel, never used to hide a turn
   * from the main timeline. */
  readonly parentMessageId: string | undefined;
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

/** The room timeline: every turn oldest first, flat — no turn is ever
 * dropped from the main list. A turn whose in-reply-to names a known
 * message keeps that as `parentMessageId`, metadata for the sub-thread
 * panel to walk the ancestor chain of whichever turn the person opened. */
export async function readRoom(tenantId: string): Promise<readonly RoomMessage[]> {
  const [inbox, sent] = await Promise.all([
    readRoomFolder(tenantId, "INBOX"),
    readRoomFolder(tenantId, "Sent"),
  ]);
  const turns = [...inbox, ...sent].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const known = new Set(turns.map((turn) => turn.messageId));
  return turns.map((turn) => ({
    id: turn.id,
    messageId: turn.messageId,
    author: turn.author,
    authorName: turn.authorName,
    body: turn.body,
    at: turn.at,
    parentMessageId:
      turn.parentId !== undefined && known.has(turn.parentId) ? turn.parentId : undefined,
  }));
}

/** The ancestor chain of a turn, oldest first, ending with the turn itself
 * — what the sub-thread panel shows for the turn the person opened. */
export function ancestorChain(
  messages: readonly RoomMessage[],
  messageId: string,
): readonly RoomMessage[] {
  const byMessageId = new Map(messages.map((message) => [message.messageId, message]));
  const chain: RoomMessage[] = [];
  let current = byMessageId.get(messageId);
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current.messageId)) {
    seen.add(current.messageId);
    chain.unshift(current);
    current =
      current.parentMessageId === undefined ? undefined : byMessageId.get(current.parentMessageId);
  }
  return chain;
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
