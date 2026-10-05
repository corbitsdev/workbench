// Mailbox + roster reads behind the workbench: agent sends, the workbench
// timeline, and the deploy roster every workbench surface shares.

import { type } from "arktype";
import { decodeMail } from "@intx/mime";
import { WorkflowDeploymentResponse } from "@intx/types";
import { reportError } from "@corbits/error-sink";

import { agentSlugFromSourceAssetName } from "../agent-deploy";
import { listTopLevelRuns } from "../agents-api";
import { WORKER_SOURCE_CONFIG } from "../worker-source";
import { personMailAddress } from "../mail-address";
import {
  deploymentLiveness,
  diedQuickly,
  redeployMode,
  type DeploymentLiveness,
  type RedeployMode,
} from "./deployment-liveness";
import { hasRedeployFailed } from "./redeploy-failures";
import { mentionedAgents } from "./mentions";
import { appendRoster } from "./workbench-roster";

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
  /** The newest deployment's liveness; stopped means nothing is running. */
  readonly latest: DeploymentLiveness;
  /** Redeploying automatically would loop: the newest run never lived, or
   * the last redeploy threw. */
  readonly capped: boolean;
};

const DeploymentsSchema = WorkflowDeploymentResponse.array();
const WorkflowAssetSchema = type({ id: "string", name: "string" }).array();

/** One non-text MIME part of a mail frame, decoded to text — what the
 * mail tools' `attachments: [{name, contentType, data}]` arrives as. */
export type MailAttachment = {
  readonly name: string;
  readonly contentType: string;
  readonly text: string;
};

// Worker's deploy asset name is not a display name anyone should read;
// every other agent's slug renders title-cased ("echo-bot" -> "Echo Bot").
export function displayAgentName(definitionName: string): string {
  if (definitionName === WORKER_SOURCE_CONFIG.assetName) return WORKER_SOURCE_CONFIG.displayName;
  const slug = agentSlugFromSourceAssetName(definitionName);
  if (slug === null) return definitionName;
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}

/** Worker is always in a new workbench and never a pickable option. */
export function isDefaultWorker(agent: Pick<ChatAgent, "assetName">): boolean {
  return agent.assetName === WORKER_SOURCE_CONFIG.assetName;
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

// Deployments list every anchor run ever created (releases included, newest
// first), joined against runs for addresses and assets for a display name.
export async function listChatAgents(tenantId: string): Promise<readonly ChatAgent[]> {
  const [deployments, assets, runs] = await Promise.all([
    getJson(deploymentsPath(tenantId), DeploymentsSchema),
    getJson(workflowAssetsPath(tenantId), WorkflowAssetSchema),
    listTopLevelRuns(tenantId),
  ]);
  const runById = new Map(runs.map((run) => [run.id, run]));
  const nameByAssetId = new Map(assets.map((asset) => [asset.id, asset.name]));

  const byAsset = new Map<
    string,
    {
      addresses: Set<string>;
      liveAddress: string | null;
      latest: DeploymentLiveness | undefined;
      capped: boolean;
    }
  >();
  for (const deployment of deployments) {
    const run = runById.get(deployment.id);
    const address = run?.address ?? "";
    const entry = byAsset.get(deployment.definitionAssetId) ?? {
      addresses: new Set<string>(),
      liveAddress: null,
      latest: undefined,
      capped: hasRedeployFailed(deployment.definitionAssetId),
    };
    if (address.length > 0) entry.addresses.add(address);
    // Deployments come back newest-first, so the first one seen per asset
    // is the latest, and the first live one seen is the current one. A run
    // the list does not carry yet is still coming up, unless the deployment
    // itself is terminal, in which case it never lived.
    const liveness = deploymentLiveness(deployment.status, run?.status);
    if (entry.latest === undefined) {
      entry.latest = liveness;
      if (run === undefined ? liveness === "stopped" : diedQuickly(run)) entry.capped = true;
    }
    if (entry.liveAddress === null && liveness !== "stopped" && address.length > 0) {
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
      latest: entry.latest ?? "stopped",
      capped: entry.capped,
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

/** Base64 to text as UTF-8. `atob` alone yields one char per byte, which
 * turns any non-ASCII body into mojibake. */
export function base64ToUtf8(base64: string): string {
  const binary = atob(base64);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

const utf8 = new TextDecoder();

// Decoded leaf parts of a frame; an undecodable frame has none.
function frameParts(raw: string, operation: string) {
  try {
    const mail = decodeMail(Uint8Array.from(atob(raw), (char) => char.charCodeAt(0)));
    // RFC 2045: a frame with no Content-Type is text/plain; the decoder
    // reports it as octet-stream.
    const bare = mail.rawHeaders["content-type"] === undefined;
    return mail.parts.map((leaf) =>
      bare && leaf.contentType === "application/octet-stream"
        ? { ...leaf, contentType: "text/plain" }
        : leaf,
    );
  } catch (cause) {
    reportError(cause, { operation });
    return [];
  }
}

/** The readable text of an RFC 5322 frame: its first unnamed `text/plain`
 * leaf, however deeply the signed and mixed wrappers nest it. */
export function frameBody(raw: string): string {
  const part = frameParts(raw, "chat_frame_body").find(
    (leaf) => leaf.filename === undefined && leaf.contentType === "text/plain",
  );
  return part === undefined ? "" : utf8.decode(part.content).replaceAll("\r\n", "\n").trim();
}

/** Every named MIME leaf of a frame, decoded. A part counts as an
 * attachment when it carries a filename; the text body has none. */
export function frameAttachments(raw: string): readonly MailAttachment[] {
  return frameParts(raw, "chat_frame_attachments").flatMap((leaf) =>
    leaf.filename === undefined
      ? []
      : [
          {
            name: leaf.filename,
            contentType: leaf.contentType,
            text: utf8.decode(leaf.content),
          },
        ],
  );
}

function extractAddress(raw: string): string {
  return (/<([^>]+)>/.exec(raw)?.[1] ?? raw).trim();
}

// ---------------------------------------------------------------------
// Sends
// ---------------------------------------------------------------------

const SendAccepted = type({ messageId: "string", uid: "number" });

/** Live mailbox updates. The stream carries no thread identity, so a caller
 * refetches on any event rather than patching a timeline in place. */

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

// Workbenches: see docs/chat-mail-threading.md.

export type WorkbenchParticipant = {
  readonly id: string;
  readonly kind: "person" | "agent";
  readonly name: string;
  /** For an agent, its current live run's address — empty when none is
   * live, which `sendToWorkbench` filters out. */
  readonly address: string;
  /** The workflow asset's raw name — only present for a `kind: "agent"`
   * row; what a released agent's redeploy re-reads/re-pushes source by. */
  readonly assetName?: string;
  /** What becomes of an agent with nothing live: redeployed on its own, or left for the person. */
  readonly redeploy?: RedeployMode;
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

// A deployment's workflow principal only appears after its first run, so
// the run listing is what makes an agent addressable from deploy time.
export async function listWorkbenchParticipants(
  tenantId: string,
  tenantDomain: string,
): Promise<readonly WorkbenchParticipant[]> {
  const [page, chatAgents] = await Promise.all([
    getJson(`/api/tenants/${encodeURIComponent(tenantId)}/principals?limit=100`, PrincipalPage),
    listChatAgents(tenantId),
  ]);
  const people = page.data
    .filter((principal) => principal.status !== "removed" && principal.kind === "user")
    .map((principal): WorkbenchParticipant => ({
      id: principal.id,
      kind: "person",
      name: principal.displayName,
      address: personMailAddress(principal.refId, tenantDomain),
    }));
  const agents = chatAgents.map((agent): WorkbenchParticipant => {
    const redeploy = redeployMode(agent);
    return {
      id: agent.id,
      kind: "agent",
      name: agent.name,
      address: agent.liveAddress ?? "",
      assetName: agent.assetName,
      ...(redeploy === undefined ? {} : { redeploy }),
    };
  });
  return [...people, ...agents];
}

export type WorkbenchMessage = {
  readonly id: string;
  /** The turn's Message-ID: what a reply in its sub-thread threads onto. */
  readonly messageId: string;
  readonly author: "me" | "other";
  readonly authorName: string;
  readonly body: string;
  readonly at: string;
  /** The sender's raw address — matched against workbench participants for a
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

// Case-insensitive: the mailbox lowercases local parts on the wire, so a
// header `from` (mixed case) and envelope `from` (lowercase) still match.
export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** A turn's display name: the matching workbench participant's name, else the
 * address local part — never the raw run/email address. */
export function resolveParticipantName(
  message: Pick<WorkbenchMessage, "author" | "authorName" | "address">,
  participants: readonly WorkbenchParticipant[],
): string {
  if (message.author === "me") return message.authorName;
  return (
    participants.find((participant) => sameAddress(participant.address, message.address))?.name ??
    message.authorName
  );
}

// Never the "You" transcript label, which stays for the row's own text.
export function resolveAvatarName(
  message: Pick<WorkbenchMessage, "author" | "authorName" | "address">,
  participants: readonly WorkbenchParticipant[],
): string {
  const matched = participants.find((participant) =>
    sameAddress(participant.address, message.address),
  );
  return matched?.name ?? resolveParticipantName(message, participants);
}

type WorkbenchTurn = {
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

/** One folder of the workbench mailbox: the person's own turns live in `Sent`,
 * everyone else's in `INBOX`. Unlike a chat, a workbench keeps every message —
 * a person-to-person turn is as much part of the workbench as an agent's. */
async function readWorkbenchFolder(
  tenantId: string,
  folder: "INBOX" | "Sent",
): Promise<WorkbenchTurn[]> {
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

// Flat, oldest first — no turn is ever dropped from the main list.
// `parentMessageId` is metadata for the sub-thread panel only.
export async function readWorkbench(tenantId: string): Promise<readonly WorkbenchMessage[]> {
  const [inbox, sent] = await Promise.all([
    readWorkbenchFolder(tenantId, "INBOX"),
    readWorkbenchFolder(tenantId, "Sent"),
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
  messages: readonly WorkbenchMessage[],
  messageId: string,
): readonly WorkbenchMessage[] {
  const byMessageId = new Map(messages.map((message) => [message.messageId, message]));
  const chain: WorkbenchMessage[] = [];
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

const TerminalRunBody = type({ error: { code: "'workflow_run_terminal'" } });

async function isTerminalRunBody(response: Response): Promise<boolean> {
  return !(TerminalRunBody(await response.json().catch(() => undefined)) instanceof type.errors);
}

// The one send seam for a workbench (see docs/chat-mail-threading.md for
// the roster mechanism).
export async function sendToWorkbench(input: {
  readonly workbenchTenantId: string;
  readonly participants: readonly WorkbenchParticipant[];
  readonly content: string;
  /** The turn this reply threads onto — a sub-thread's parent. */
  readonly inReplyTo?: string;
}): Promise<void> {
  const live = input.participants.filter(
    (participant) => participant.kind === "agent" && participant.address.includes("@"),
  );
  if (live.length === 0) {
    throw new ChatApiError("No agent is in this workbench yet, so there is nobody to send to.");
  }
  // An @mention narrows the fan-out to the agents it names; the roster block
  // below still lists everyone, so a narrowed message can still be handed on.
  const mentioned = mentionedAgents(input.content, live);
  const to = (mentioned.length > 0 ? mentioned : live).map((agent) => agent.address);
  const people = input.participants.filter(
    (participant) => participant.kind === "person" && participant.address.includes("@"),
  );
  const body = appendRoster(input.content, [
    ...people.map((person) => ({
      name: person.name,
      address: person.address,
      kind: "person" as const,
    })),
    ...live.map((agent) => ({
      name: agent.name,
      address: agent.address,
      kind: "agent" as const,
    })),
  ]);
  let response: Response;
  try {
    response = await fetch(`${mailboxPath(input.workbenchTenantId)}/send`, {
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
    if (response.status === 409 && (await isTerminalRunBody(response))) {
      throw new ChatApiError("This agent has finished and can't take new messages.", 409);
    }
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
