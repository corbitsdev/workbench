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
import { reportError } from "@corbits/error-sink";

import { agentSlugFromSourceAssetName } from "../agent-deploy";
import { listTopLevelRuns } from "../agents-api";
import { MYRA_SOURCE_CONFIG } from "../myra-source";
import { appendRoster } from "./room-roster";

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
  /** The newest deployment's status for this agent's asset — `undefined`
   * when it has never been deployed. `"pending"`/`"recovering"` mean a run
   * is on the way up; a terminal status (`released`, `failed`,
   * `destroy_failed`, `stopped`) means nothing is running and nothing is
   * coming unless someone restarts it. */
  readonly latestStatus: string | undefined;
};

const LIVE_DEPLOYMENT_STATUSES = new Set(["deployed", "pending", "recovering"]);
/** A deployment status that means a run is on the way up but not live yet
 * — distinct from a terminal status, which means nothing is running. */
export const STARTING_DEPLOYMENT_STATUSES = new Set(["pending", "recovering"]);

const DeploymentsSchema = WorkflowDeploymentResponse.array();
const WorkflowAssetSchema = type({ id: "string", name: "string" }).array();

/** One non-text MIME part of a mail frame, decoded to text — what the
 * mail tools' `attachments: [{name, contentType, data}]` arrives as. */
export type MailAttachment = {
  readonly name: string;
  readonly contentType: string;
  readonly text: string;
};

export type ChatMessage = {
  readonly id: string;
  readonly author: "me" | "agent";
  readonly authorName: string;
  readonly body: string;
  readonly at: string;
  readonly attachments: readonly MailAttachment[];
};

export type ChatSummary = {
  /** Route id: the agent's run id. */
  readonly id: string;
  readonly title: string;
  readonly agentName: string;
  readonly preview: string;
  readonly lastActivityAt: string;
  /** Who sent the newest turn — an "agent" turn is an unread reply until
   * the chat is opened. */
  readonly lastAuthor: "me" | "agent";
  /** The newest turn's Message-ID, compared against what was last seen. */
  readonly lastMessageId: string;
};

/** Myra is the one default agent; her deploy asset name is not a display
 * name anyone should have to read. Any other agent's deploy asset name
 * encodes its slug (`agent-<slug>-source`), which renders title-cased with
 * hyphens as spaces ("echo-bot" -> "Echo Bot"). */
export function displayAgentName(definitionName: string): string {
  if (definitionName === MYRA_SOURCE_CONFIG.assetName) return MYRA_SOURCE_CONFIG.displayName;
  const slug = agentSlugFromSourceAssetName(definitionName);
  if (slug === null) return definitionName;
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
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

  const byAsset = new Map<
    string,
    { addresses: Set<string>; liveAddress: string | null; latestStatus: string | undefined }
  >();
  for (const deployment of deployments) {
    const address = addressByRunId.get(deployment.id);
    if (address === undefined || address.length === 0) continue;
    const entry = byAsset.get(deployment.definitionAssetId) ?? {
      addresses: new Set<string>(),
      liveAddress: null,
      latestStatus: undefined,
    };
    entry.addresses.add(address);
    // Deployments come back newest-first, so the first one seen per asset
    // is the latest, and the first live one seen is the current one.
    if (entry.latestStatus === undefined) entry.latestStatus = deployment.status;
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
      latestStatus: entry.latestStatus,
    };
  });
}

/** True once an agent's latest deployment has gone terminal (or it has
 * never been deployed) — nothing is running and nothing is coming up on
 * its own; a restart is the only way forward. False while a run is live or
 * still on its way up (`pending`/`recovering`). */
export function isAgentNotRunning(agent: Pick<ChatAgent, "liveAddress" | "latestStatus">): boolean {
  if (agent.liveAddress !== null) return false;
  return agent.latestStatus === undefined || !STARTING_DEPLOYMENT_STATUSES.has(agent.latestStatus);
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

/** Base64 to text as UTF-8. `atob` alone yields one char per byte, which
 * turns any non-ASCII body into mojibake. */
export function base64ToUtf8(base64: string): string {
  const binary = atob(base64);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

/** The readable text of an RFC 5322 frame: the bytes after the header
 * section, or the first `text/plain` part of a multipart one. */
export function frameBody(raw: string): string {
  let decoded: string;
  try {
    decoded = base64ToUtf8(raw);
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

/** Every named, non-inline MIME leaf of a frame, decoded. A part counts as
 * an attachment when it carries a filename; the text body has none. */
export function frameAttachments(raw: string): readonly MailAttachment[] {
  let decoded: string;
  try {
    decoded = base64ToUtf8(raw);
  } catch (cause) {
    reportError(cause, { operation: "chat_frame_attachments" });
    return [];
  }
  return attachmentParts(decoded.replace(/\r\n/g, "\n"));
}

function attachmentParts(entity: string): MailAttachment[] {
  const split = entity.indexOf("\n\n");
  if (split < 0) return [];
  const headers = entity.slice(0, split).replace(/\n[ \t]+/g, " ");
  const body = entity.slice(split + 2);
  const boundary = /boundary="?([^";\n]+)"?/i.exec(headers)?.[1];
  if (boundary !== undefined) {
    const found: MailAttachment[] = [];
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith("--")) break;
      found.push(...attachmentParts(part.replace(/^\n/, "")));
    }
    return found;
  }
  const name = /(?:filename|name)\*?="?([^";\n]+)"?/i.exec(headers)?.[1];
  if (name === undefined) return [];
  const contentType =
    /content-type:\s*([^;\n]+)/i.exec(headers)?.[1]?.trim() ?? "application/octet-stream";
  const base64 = /content-transfer-encoding:\s*base64/i.test(headers);
  return [{ name, contentType, text: base64 ? decodeBase64(body) : body.trim() }];
}

function decodeBase64(body: string): string {
  try {
    return base64ToUtf8(body.replace(/\s+/g, ""));
  } catch (cause) {
    reportError(cause, { operation: "chat_attachment_decode" });
    return "";
  }
}

function extractAddress(raw: string): string {
  return (/<([^>]+)>/.exec(raw)?.[1] ?? raw).trim();
}

/** Addresses on a frame's `To:` header, unfolded and parsed straight from
 * `raw` — the fallback for a person turn, whose `envelope.to` the mailbox
 * currently reports empty (library fix in flight). */
function toHeaderAddresses(raw: string): string[] {
  let decoded: string;
  try {
    decoded = base64ToUtf8(raw);
  } catch {
    return [];
  }
  const headers = decoded.replace(/\r\n/g, "\n").split("\n\n")[0] ?? "";
  const unfolded = headers.replace(/\n[ \t]+/g, " ");
  const to = /^to:\s*(.+)$/im.exec(unfolded)?.[1];
  return to === undefined ? [] : to.split(",").map((address) => address.trim());
}

/** The run address on a message, from whichever side (from/to) carries
 * one — a plain address, not just its local part, so it can be matched
 * against an agent's full address set. */
function participantAddress(
  envelope: { from: string; to: readonly string[] },
  raw: string,
): string | undefined {
  const to = envelope.to.length > 0 ? envelope.to : toHeaderAddresses(raw);
  return [envelope.from, ...to]
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
  readonly attachments: readonly MailAttachment[];
};

/** Every chat turn in one folder: the person's own in `Sent`, the agents'
 * in `INBOX`. A message with no run address on either side is not a chat
 * turn and is dropped. */
async function readFolder(tenantId: string, folder: "INBOX" | "Sent"): Promise<MailTurn[]> {
  const page = await getJson(`${mailboxPath(tenantId)}?folder=${folder}&limit=100`, InboxPage);
  return page.messages.flatMap((message) => {
    const address = participantAddress(message.envelope, message.raw);
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
        attachments: frameAttachments(message.raw),
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

/** The chat title is always the person's own opening turn — never an
 * agent reply — so a chat never titles itself off what the agent said. */
function chatTitle(turns: readonly MailTurn[], agentName: string): string {
  const first = turns.find((turn) => turn.author === "me");
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
        lastAuthor: newest.author,
        lastMessageId: newest.messageId,
      };
    })
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
}

// ---------------------------------------------------------------------
// Reply-ready: a chat is unread until it has been opened at its newest
// message. Tracked per-viewer in localStorage — a convenience, not data of
// record, so a missing/blocked store just falls back to "ready".
// ---------------------------------------------------------------------

const CHAT_SEEN_KEY_PREFIX = "workbench:chat-seen:";

/** Marks a chat as read up to its newest turn. Call when a chat is opened. */
export function markChatSeen(chatId: string, lastMessageId: string | undefined): void {
  if (lastMessageId === undefined) return;
  try {
    localStorage.setItem(`${CHAT_SEEN_KEY_PREFIX}${chatId}`, lastMessageId);
  } catch (cause) {
    reportError(cause, { operation: "chat_mark_seen", refId: chatId });
  }
}

/** True when the chat's newest turn is an agent reply that has not yet been
 * seen in this browser. */
export function isChatReplyReady(
  summary: Pick<ChatSummary, "id" | "lastAuthor" | "lastMessageId">,
): boolean {
  if (summary.lastAuthor !== "agent") return false;
  try {
    return localStorage.getItem(`${CHAT_SEEN_KEY_PREFIX}${summary.id}`) !== summary.lastMessageId;
  } catch (cause) {
    reportError(cause, { operation: "chat_reply_ready_check", refId: summary.id });
    return true;
  }
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
      attachments: turn.attachments,
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
  /** The workflow asset's raw name — only present for a `kind: "agent"`
   * row; what a released agent's redeploy re-reads/re-pushes source by. */
  readonly assetName?: string;
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
    assetName: agent.assetName,
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
  /** The sender's raw address — matched against room participants for a
   * display name; falls back to `authorName` (the address local part) when
   * no participant matches. */
  readonly address: string;
  /** In-reply-to parent, when this turn named one and it matched a known
   * message — metadata for the sub-thread panel, never used to hide a turn
   * from the main timeline. */
  readonly parentMessageId: string | undefined;
  readonly attachments: readonly MailAttachment[];
};

function authorName(address: string): string {
  const local = address.split("@")[0]?.replace(/^.*</, "") ?? address;
  return local.length > 0 ? local : address;
}

/** A turn's display name: the matching room participant's name, else the
 * address local part — never the raw run/email address. */
export function resolveParticipantName(
  message: Pick<RoomMessage, "author" | "authorName" | "address">,
  participants: readonly RoomParticipant[],
): string {
  if (message.author === "me") return message.authorName;
  return (
    participants.find((participant) => participant.address === message.address)?.name ??
    message.authorName
  );
}

/** A turn's avatar name: the matching participant's real name, including
 * the person's own — never the "You" transcript label, which stays for the
 * row's own text elsewhere. Falls back to `resolveParticipantName` when no
 * participant matches the turn's address. */
export function resolveAvatarName(
  message: Pick<RoomMessage, "author" | "authorName" | "address">,
  participants: readonly RoomParticipant[],
): string {
  const matched = participants.find((participant) => participant.address === message.address);
  return matched?.name ?? resolveParticipantName(message, participants);
}

type RoomTurn = {
  readonly id: string;
  readonly messageId: string;
  readonly parentId: string | undefined;
  readonly author: "me" | "other";
  readonly authorName: string;
  readonly address: string;
  readonly body: string;
  readonly at: string;
  readonly attachments: readonly MailAttachment[];
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
    address: extractAddress(message.envelope.from),
    body: frameBody(message.raw),
    at: message.envelope.date,
    attachments: frameAttachments(message.raw),
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
    address: turn.address,
    body: turn.body,
    at: turn.at,
    attachments: turn.attachments,
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
 * other. The body carries a trailing roster of every agent's name and
 * run address (the same rows the Participants panel reads), so an agent
 * can hand a task to another agent in the room — the hub only delivers to
 * a run address, which only the client otherwise knows. */
export async function sendToRoom(input: {
  readonly roomTenantId: string;
  readonly agents: readonly RoomParticipant[];
  readonly content: string;
  /** The turn this reply threads onto — a sub-thread's parent. */
  readonly inReplyTo?: string;
}): Promise<void> {
  const live = input.agents.filter((agent) => agent.address.includes("@"));
  if (live.length === 0) {
    throw new ChatApiError("No agent is in this workbench yet, so there is nobody to send to.");
  }
  const to = live.map((agent) => agent.address);
  const body = appendRoster(
    input.content,
    live.map((agent) => ({ name: agent.name, address: agent.address })),
  );
  let response: Response;
  try {
    response = await fetch(`${mailboxPath(input.roomTenantId)}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to,
        subject: input.content.slice(0, 60),
        body,
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
