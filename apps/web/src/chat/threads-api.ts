// Chats are mail threads. One chat has exactly one agent: the person
// triggers the agent's deployment run over the stock
// `POST /workflows/:runId/mail`, and the agent's reply lands in the
// person's own `@corbits/mailbox` inbox, threaded by In-Reply-To. This
// file is the only seam between the chat UI and those two surfaces —
// nothing here touches a chat-specific hub route, because none exist.
//
// The person's own outgoing turns are held client-side: mailbox rows are
// written for addressed principals only, and a run address is not a
// mailbox, so a trigger leaves no durable copy anywhere the person can
// read it back.

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
  /** The deployment's anchor run id — what a trigger is addressed to. */
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
  /** Route id: a mailbox thread's root uid, or a local id while the
   * agent has not answered a brand-new chat yet. */
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

/** Thread nodes nest arbitrarily; arktype expresses recursion only through a
 * named scope, so the tree is validated one level at a time as it is walked. */
const ThreadNode = type({ uid: "number", envelope: Envelope, children: "unknown[]" });
const ThreadList = type({ threads: "unknown[]" });
const ThreadOne = type({ thread: "unknown" });

type ThreadNodeShape = typeof ThreadNode.infer;

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

function parseNode(value: unknown): ThreadNodeShape {
  const parsed = ThreadNode(value);
  if (parsed instanceof type.errors) {
    throw new ChatApiError(`Unexpected mailbox thread node: ${parsed.summary}`);
  }
  return parsed;
}

function flatten(node: ThreadNodeShape): ThreadNodeShape[] {
  return [node, ...node.children.map(parseNode).flatMap(flatten)];
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

async function inboxBodies(tenantId: string): Promise<Map<number, string>> {
  const page = await getJson(`${mailboxPath(tenantId)}?limit=100`, InboxPage);
  return new Map(page.messages.map((message) => [message.uid, frameBody(message.raw)]));
}

// ---------------------------------------------------------------------
// The person's own turns
// ---------------------------------------------------------------------

const SentTurn = type({
  localId: "string",
  runId: "string",
  agentName: "string",
  messageId: "string",
  body: "string",
  at: "string",
});
const SentTurns = SentTurn.array();
type SentTurn = typeof SentTurn.infer;

function storageKey(tenantId: string): string {
  return `workbench.chat.sent.${tenantId}`;
}

function readSentTurns(tenantId: string): SentTurn[] {
  const raw = window.localStorage.getItem(storageKey(tenantId));
  if (raw === null) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const parsed = SentTurns(json);
  return parsed instanceof type.errors ? [] : parsed;
}

function writeSentTurn(tenantId: string, turn: SentTurn): void {
  window.localStorage.setItem(
    storageKey(tenantId),
    JSON.stringify([...readSentTurns(tenantId), turn]),
  );
}

// ---------------------------------------------------------------------
// Sends
// ---------------------------------------------------------------------

const TriggerAccepted = type({ runId: "string", address: "string", messageId: "string" });

async function triggerAgent(tenantId: string, runId: string, content: string): Promise<string> {
  const path = `/api/tenants/${encodeURIComponent(tenantId)}/workflows/${encodeURIComponent(runId)}/mail`;
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
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
  const parsed = TriggerAccepted(await response.json().catch(() => undefined));
  if (parsed instanceof type.errors) {
    throw new ChatApiError(`Unexpected trigger response: ${parsed.summary}`);
  }
  return parsed.messageId;
}

/** Starts a chat with one agent. Returns the local chat id to route to —
 * the mailbox has no thread for it until the agent answers. */
export async function startChat(
  tenantId: string,
  agent: ChatAgent,
  content: string,
): Promise<string> {
  const messageId = await triggerAgent(tenantId, agent.runId, content);
  const localId = `local-${messageId}`;
  writeSentTurn(tenantId, {
    localId,
    runId: agent.runId,
    agentName: agent.name,
    messageId,
    body: content,
    at: new Date().toISOString(),
  });
  return localId;
}

/** A reply rides the same trigger route: the run is the conversation, and
 * the agent threads its answer onto the chat it is already holding. */
export async function replyInChat(
  tenantId: string,
  chat: { readonly id: string; readonly runId: string; readonly agentName: string },
  content: string,
): Promise<void> {
  const messageId = await triggerAgent(tenantId, chat.runId, content);
  writeSentTurn(tenantId, {
    localId: chat.id,
    runId: chat.runId,
    agentName: chat.agentName,
    messageId,
    body: content,
    at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------
// Chat listing and reads
// ---------------------------------------------------------------------

function addressRunId(address: string): string | undefined {
  const local = address.split("@")[0]?.trim().replace(/^.*</, "");
  return local !== undefined && local.startsWith("run_") ? local : undefined;
}

/** The agent behind one thread: the run address among its participants. */
function threadRunId(nodes: readonly ThreadNodeShape[]): string | undefined {
  for (const node of nodes) {
    for (const address of [node.envelope.from, ...node.envelope.to]) {
      const runId = addressRunId(address);
      if (runId !== undefined) return runId;
    }
  }
  return undefined;
}

export type ChatThread = {
  readonly id: string;
  readonly title: string;
  readonly agentName: string;
  readonly runId: string;
  readonly messages: readonly ChatMessage[];
};

type ThreadRead = {
  readonly nodes: readonly ThreadNodeShape[];
  readonly root: ThreadNodeShape;
};

async function listThreadTrees(tenantId: string): Promise<ThreadRead[]> {
  const page = await getJson(`${mailboxPath(tenantId)}/threads?folder=INBOX`, ThreadList);
  return page.threads.map((raw) => {
    const root = parseNode(raw);
    return { root, nodes: flatten(root) };
  });
}

/** Every chat the person has: one per mailbox thread, plus any chat they
 * started that the agent has not answered yet. */
export async function listChats(tenantId: string): Promise<readonly ChatSummary[]> {
  const sent = readSentTurns(tenantId);
  const trees = await listThreadTrees(tenantId);
  const answeredRuns = new Set<string>();

  const fromMail: ChatSummary[] = trees.map(({ root, nodes }) => {
    const runId = threadRunId(nodes);
    if (runId !== undefined) answeredRuns.add(runId);
    const newest = nodes[nodes.length - 1] ?? root;
    const agentName = sent.find((turn) => turn.runId === runId)?.agentName ?? runId ?? "Agent";
    return {
      id: String(root.uid),
      title: root.envelope.subject.length > 0 ? root.envelope.subject : agentName,
      agentName,
      preview: newest.envelope.subject,
      lastActivityAt: newest.envelope.date,
    };
  });

  const pending: ChatSummary[] = sent
    .filter((turn) => !answeredRuns.has(turn.runId))
    .filter((turn, index, rows) => rows.findIndex((row) => row.localId === turn.localId) === index)
    .map((turn) => ({
      id: turn.localId,
      title: turn.body.slice(0, 60),
      agentName: turn.agentName,
      preview: turn.body.slice(0, 80),
      lastActivityAt: turn.at,
    }));

  return [...fromMail, ...pending].sort(
    (a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
  );
}

/** One chat's full transcript: the agent's mail turns merged with the
 * person's own trigger turns, oldest first. */
export async function readChat(tenantId: string, chatId: string): Promise<ChatThread> {
  const sent = readSentTurns(tenantId);
  if (chatId.startsWith("local-")) {
    const turns = sent.filter((turn) => turn.localId === chatId);
    const first = turns[0];
    if (first === undefined) throw new ChatApiError("That chat is not on this device.", 404);
    return {
      id: chatId,
      title: first.body.slice(0, 60),
      agentName: first.agentName,
      runId: first.runId,
      messages: turns.map((turn) => ({
        id: turn.messageId,
        author: "me",
        authorName: "You",
        body: turn.body,
        at: turn.at,
      })),
    };
  }

  const [page, bodies] = await Promise.all([
    getJson(
      `${mailboxPath(tenantId)}/threads/${encodeURIComponent(chatId)}?folder=INBOX`,
      ThreadOne,
    ),
    inboxBodies(tenantId),
  ]);
  const root = parseNode(page.thread);
  const nodes = flatten(root);
  const runId = threadRunId(nodes) ?? "";
  const agentName = sent.find((turn) => turn.runId === runId)?.agentName ?? runId;

  const mine = sent.filter((turn) => turn.runId === runId);
  const messages: ChatMessage[] = [
    ...mine.map((turn): ChatMessage => ({
      id: turn.messageId,
      author: "me",
      authorName: "You",
      body: turn.body,
      at: turn.at,
    })),
    ...nodes.map((node): ChatMessage => ({
      id: String(node.uid),
      author: "agent",
      authorName: agentName,
      body: bodies.get(node.uid) ?? node.envelope.subject,
      at: node.envelope.date,
    })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  return {
    id: chatId,
    title: root.envelope.subject.length > 0 ? root.envelope.subject : agentName,
    agentName,
    runId,
    messages,
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
