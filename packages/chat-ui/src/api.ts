// The chat surface's one seam to `@corbits/chat`'s HTTP routes (see
// packages/chat/src/routes.ts). Every fetch the chat/* components make goes
// through a function here, and every response is parsed with an arktype
// schema at the boundary — a route shape change is a one-file fix.
//
// The wire-level `Part` and participant schemas are imported from
// `@corbits/chat` rather than redefined here: this UI validates the wire
// contract at its own boundary, but against the one real schema rather than
// a second, hand-copied one.

import { type } from "arktype";
import type { ArkErrors } from "arktype";
import { Part } from "@corbits/chat/parts";
import { parseParticipants } from "@corbits/chat/participants";
import type { ParticipantRecord } from "@corbits/chat/participants";
import { CHAT_STRINGS } from "./strings";

export {
  TextPart,
  ReasoningPart,
  ToolTracePart,
  BlockPart,
  FilePart,
  EventPart,
  Part,
} from "@corbits/chat/parts";
export type { ParticipantRecord } from "@corbits/chat/participants";
export { REACTION_EMOJI } from "@corbits/chat/reaction-emoji";
export type { ReactionEmoji } from "@corbits/chat/reaction-emoji";

export const ChannelKind = type("'channel' | 'chat'");
export type ChannelKind = typeof ChannelKind.infer;

/** Every channel kind this UI has bespoke handling for. Any other value on
 * the wire is a channel kind the server knows about that this UI doesn't —
 * it renders through the neutral, kind-agnostic path rather than being
 * rejected at parse time. */
export function isKnownChannelKind(kind: string): kind is ChannelKind {
  return kind === "channel" || kind === "chat";
}

const ChannelWire = type({
  id: "string",
  title: "string",
  kind: "string",
  pinned: "boolean",
  participants: "unknown[]",
  "legacy?": "boolean",
  // Row signals `GET /channels` annotates when it can resolve a
  // channel's mailbox (see `packages/chat/src/routes.ts`): absent,
  // never a fabricated zero, for a channel whose session isn't
  // resolvable yet. `unreadCount` is the one exception — 0 is itself
  // the honest "nothing unread" answer once a mailbox is resolved.
  "unreadCount?": "number",
  "lastActivityAt?": "string",
  "live?": "boolean",
  // `GET /channels` sets this server-side (see
  // `packages/chat/src/routes.ts`) only for a channel projected into
  // this tenant via CL-5882's shared-channel machinery: "shared via
  // parent · <parent name>" for true siblings, "shared · <owning tenant
  // name>" otherwise. Absent for every ordinary, non-projected channel.
  "sharedLabel?": "string",
});

const Channel = ChannelWire.pipe((wire) => ({
  ...wire,
  participants: parseParticipants(wire.participants),
}));
export type Channel = Omit<typeof ChannelWire.infer, "participants"> & {
  readonly participants: readonly ParticipantRecord[];
};

const ChannelsResponse = type({ items: ChannelWire.array() }).pipe(
  (response) => ({
    items: response.items.map((wire) => ({
      ...wire,
      participants: parseParticipants(wire.participants),
    })),
  }),
);

// `tenantId`/`tenantName`/`tenantMonogram` are set server-side only for a
// message sent by a shared channel's "other side" participant — a share
// member of a tenant this channel was projected into (see
// `resolveMessageSenderTenant` in `packages/chat/src/routes.ts`). Absent
// for every ordinary same-tenant sender.
export const MessageSender = type({
  name: "string | null",
  address: "string",
  "tenantId?": "string",
  "tenantName?": "string",
  "tenantMonogram?": "string",
});
export type MessageSender = typeof MessageSender.infer;

// `POST .../reactions/toggle`'s response shape, and the per-emoji entry
// `GET /messages` batches onto every item's `reactions` array — see
// `packages/chat/src/reactions.ts`'s `ReactionSummary`. `reactedByMe` is
// this signed-in principal's own membership in the emoji's reactor set,
// never another principal's.
const ReactionSummaryWire = type({
  emoji: "string",
  count: "number",
  reactedByMe: "boolean",
});
export type ReactionSummary = typeof ReactionSummaryWire.infer;

const MessageItem = type({
  id: "string",
  createdAt: "string",
  parts: Part.array(),
  sender: MessageSender,
  // Both fields are simply absent from the wire when the host never
  // injected the corresponding store (see `CreateChatRoutesDeps` in
  // `packages/chat/src/routes.ts`) — never a fabricated empty array or
  // `false`, mirroring how `unreadCount` on `Channel` works.
  "reactions?": ReactionSummaryWire.array(),
  "pinned?": "boolean",
});
export type MessageItem = typeof MessageItem.infer;

const MessagesResponse = type({
  items: MessageItem.array(),
  "nextCursor?": "string",
});
export type MessagesResponse = typeof MessagesResponse.infer;

const SentMessage = type({
  id: "string",
  createdAt: "string",
  "threadId?": "string",
});

const ReadState = type({
  "lastSeenCreatedAt?": "string | null",
  "lastSeenId?": "string | null",
});

// The shape `GET /api/tenants/:t/workflows/deployments` returns: a run, one row
// per definition executing in the bench. It carries no display name — only
// the id and the asset id its definition was hydrated from — so the mention
// popover derives a readable label from `definitionAssetId` (see
// `runDisplayName` below).
const Run = type({
  id: "string",
  tenantId: "string",
  definitionAssetId: "string",
  status: "string",
  createdAt: "string",
});
export type Run = typeof Run.infer;

const RunsResponse = Run.array();

// `GET /channels/:id/invitable` (see packages/chat/src/routes.ts): the
// tenant's deployed, launchable workflow definitions this channel can
// invite an agent from — never including the channel's own host.
const InvitableDefinition = type({
  id: "string",
  name: "string",
  "description?": "string",
});
export type InvitableDefinition = typeof InvitableDefinition.infer;

const InvitableDefinitionsResponse = type({
  items: InvitableDefinition.array(),
});

const InvitedAgent = type({ address: "string", definitionId: "string" });
export type InvitedAgent = typeof InvitedAgent.infer;

export class ChatApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type Validator<T> = (data: unknown) => T | ArkErrors;

async function request<T>(
  path: string,
  schema: Validator<T>,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new ChatApiError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (response.status === 401) {
    throw new ChatApiError(`Not signed in for ${path}.`, 401);
  }
  if (!response.ok) {
    throw new ChatApiError(
      `The server answered ${response.status} for ${path}.`,
      response.status,
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new ChatApiError(
      `Unexpected response shape from ${path}: ${parsed.summary}`,
    );
  }
  return parsed;
}

function channelsPath(tenantId: string, kind: ChannelKind): string {
  return `/api/tenants/${tenantId}/chat/channels?kind=${kind}`;
}

export function listChannels(
  tenantId: string,
  kind: ChannelKind,
): Promise<readonly Channel[]> {
  return request(channelsPath(tenantId, kind), ChannelsResponse).then(
    (page) => page.items,
  );
}

/**
 * Every channel a tenant holds, of any kind — `kind` is optional
 * server-side (`packages/chat/src/routes.ts`'s `GET /channels`), and
 * channel kinds are open-ended (`packages/chat/src/kinds.ts`), so this
 * omits the query param entirely rather than hardcoding the two kinds
 * this UI has bespoke handling for. Used where the caller needs the
 * complete channel-host/participant surface regardless of kind — e.g.
 * computing the tenant's folded-run id set (see `folded-run-ids.ts`).
 */
export function listAllChannels(tenantId: string): Promise<readonly Channel[]> {
  return request(
    `/api/tenants/${tenantId}/chat/channels`,
    ChannelsResponse,
  ).then((page) => page.items);
}

// A chat is a direct thread with exactly one counterpart, picked at
// creation and fixed for its lifetime: either an agent (`definitionId`)
// or a bench member (`principalId`) — never both. The name is optional
// either way (the server titles it by the counterpart's handle when
// omitted). A channel is the pinned, multiplayer kind: name-only, no
// counterpart attached at creation. See `packages/chat/src/routes.ts`
// `POST /channels` for the server side of this union.
export type CreateChannelInput =
  | { readonly kind: "channel"; readonly name: string }
  | {
      readonly kind: "chat";
      readonly definitionId: string;
      readonly name?: string;
    }
  | {
      readonly kind: "chat";
      readonly principalId: string;
      readonly name?: string;
    };

export function createChannel(
  tenantId: string,
  input: CreateChannelInput,
): Promise<Channel> {
  return request(`/api/tenants/${tenantId}/chat/channels`, Channel, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function listMessages(
  tenantId: string,
  channelId: string,
  cursor?: string,
): Promise<MessagesResponse> {
  const query = cursor !== undefined ? `?cursor=${cursor}` : "";
  return request(
    `/api/tenants/${tenantId}/chat/channels/${channelId}/messages${query}`,
    MessagesResponse,
  );
}

const BlobResponse = type({ contentBase64: "string" });

/**
 * A `FilePart`'s bytes, base64-encoded (`GET /channels/:id/blobs/:blobId`).
 * There is no stored link from a chat blob to a Library artifact today —
 * this is the fallback read path a host uses to open a chat attachment
 * without one (see `chat-artifact-open.ts` in the web app).
 */
export function fetchChannelBlob(
  tenantId: string,
  channelId: string,
  blobId: string,
): Promise<string> {
  return request(
    `/api/tenants/${tenantId}/chat/channels/${channelId}/blobs/${encodeURIComponent(blobId)}`,
    BlobResponse,
  ).then((body) => body.contentBase64);
}

export type SendMessageOptions = {
  readonly threadId?: string;
  readonly inReplyToMessageId?: string;
};

export function sendMessage(
  tenantId: string,
  channelId: string,
  parts: readonly Part[],
  options?: SendMessageOptions,
): Promise<{
  readonly id: string;
  readonly createdAt: string;
  readonly threadId?: string;
}> {
  const body: Record<string, unknown> = { parts };
  if (options?.threadId !== undefined) body["threadId"] = options.threadId;
  if (options?.inReplyToMessageId !== undefined) {
    body["inReplyToMessageId"] = options.inReplyToMessageId;
  }
  return request(
    `/api/tenants/${tenantId}/chat/channels/${channelId}/messages`,
    SentMessage,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/**
 * Toggles this signed-in principal's reaction with `emoji` on a
 * message — `POST .../reactions/toggle` (see
 * `packages/chat/src/routes.ts`). Returns the emoji's fresh summary
 * (count and whether this principal is now among the reactors); the
 * caller re-renders from this rather than assuming its own optimistic
 * guess, the same anti-drift rule `submitPoll`'s live tally follows.
 */
export function toggleReaction(
  tenantId: string,
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<ReactionSummary> {
  return request(
    `/api/tenants/${tenantId}/chat/channels/${channelId}/messages/${messageId}/reactions/toggle`,
    ReactionSummaryWire,
    { method: "POST", body: JSON.stringify({ emoji }) },
  );
}

const PinnedWire = type({
  messageId: "string",
  pinnedBy: "string",
  pinnedAt: "string",
});
export type Pinned = typeof PinnedWire.infer;

function pinPath(tenantId: string, channelId: string, messageId: string) {
  return `/api/tenants/${tenantId}/chat/channels/${channelId}/messages/${messageId}/pin`;
}

export function pinMessage(
  tenantId: string,
  channelId: string,
  messageId: string,
): Promise<Pinned> {
  return request(pinPath(tenantId, channelId, messageId), PinnedWire, {
    method: "POST",
  });
}

export async function unpinMessage(
  tenantId: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  const response = await fetch(pinPath(tenantId, channelId, messageId), {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new ChatApiError(
      `The server answered ${response.status} for ${pinPath(tenantId, channelId, messageId)}.`,
      response.status,
    );
  }
}

// A pinned message's own content, for the pinned strip's preview — the
// same `MessageItem` shape plus who pinned it and when. See `GET
// /channels/:id/pins` in `packages/chat/src/routes.ts`.
const PinnedMessageWire = MessageItem.and({
  pinnedBy: "string",
  pinnedAt: "string",
});
export type PinnedMessage = typeof PinnedMessageWire.infer;

const PinnedMessagesResponse = type({ items: PinnedMessageWire.array() });

export function listPinnedMessages(
  tenantId: string,
  channelId: string,
): Promise<readonly PinnedMessage[]> {
  return request(
    `/api/tenants/${tenantId}/chat/channels/${channelId}/pins`,
    PinnedMessagesResponse,
  ).then((page) => page.items);
}

// `parentThreadId` is the thread this one hangs directly off: null for the
// root thread, the root thread's id for a depth-1 thread, a depth-1
// thread's id for a depth-2 sub-thread. Two levels, stop — see
// `resolveThreadAnchor` in `packages/chat/src/threads.ts`.
export const ChannelThread = type({
  id: "string",
  kind: "'root' | 'reply' | 'delivery'",
  parentMessageId: "string | null",
  parentThreadId: "string | null",
  runRef: "string | null",
  title: "string | null",
  createdAt: "string",
});
export type ChannelThread = typeof ChannelThread.infer;

const ThreadsResponse = type({
  rootThreadId: "string",
  items: ChannelThread.array(),
});

export function listThreads(
  tenantId: string,
  channelId: string,
): Promise<{
  readonly rootThreadId: string;
  readonly items: readonly ChannelThread[];
}> {
  return request(
    `/api/tenants/${tenantId}/chat/channels/${channelId}/threads`,
    ThreadsResponse,
  );
}

const ThreadMessagesResponse = type({
  thread: ChannelThread,
  items: MessageItem.array(),
});
export type ThreadMessagesResponse = typeof ThreadMessagesResponse.infer;

export function listThreadMessages(
  tenantId: string,
  channelId: string,
  threadId: string,
): Promise<ThreadMessagesResponse> {
  return request(
    `/api/tenants/${tenantId}/chat/channels/${channelId}/threads/${threadId}/messages`,
    ThreadMessagesResponse,
  );
}

/**
 * A first-class fork: spawn a sub-thread rooted at any message inside a
 * thread — something Slack doesn't have (CL-5948). Idempotent per origin
 * message, and honors the two-level cap server-side: forking a message
 * already inside a sub-thread creates a sibling sub-thread under that
 * sub-thread's parent, never a third level (see `resolveThreadAnchor` in
 * `packages/chat/src/threads.ts`).
 */
export function forkThread(
  tenantId: string,
  channelId: string,
  parentMessageId: string,
  title?: string,
): Promise<ChannelThread> {
  const body: Record<string, unknown> = { parentMessageId };
  if (title !== undefined) body["title"] = title;
  return request(
    `/api/tenants/${tenantId}/chat/channels/${channelId}/threads/fork`,
    ChannelThread,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function putReadState(
  tenantId: string,
  channelId: string,
  input: { readonly lastSeenCreatedAt: string; readonly lastSeenId: string },
): Promise<void> {
  return request(
    `/api/tenants/${tenantId}/chat/channels/${channelId}/read-state`,
    ReadState,
    { method: "PUT", body: JSON.stringify(input) },
  ).then(() => undefined);
}

export function listRuns(tenantId: string): Promise<readonly Run[]> {
  return request(
    `/api/tenants/${tenantId}/workflows/deployments`,
    RunsResponse,
  );
}

export function listInvitableDefinitions(
  tenantId: string,
  channelId: string,
): Promise<readonly InvitableDefinition[]> {
  return request(
    `/api/tenants/${tenantId}/chat/channels/${channelId}/invitable`,
    InvitableDefinitionsResponse,
  ).then((page) => page.items);
}

/**
 * The tenant-wide invitable listing (`GET /invitable-definitions`) the
 * new-chat dialog reads before any channel exists — the per-channel
 * variant above 404s on a channel id that isn't real.
 */
export function listTenantInvitableDefinitions(
  tenantId: string,
): Promise<readonly InvitableDefinition[]> {
  return request(
    `/api/tenants/${tenantId}/chat/invitable-definitions`,
    InvitableDefinitionsResponse,
  ).then((page) => page.items);
}

export function inviteAgent(
  tenantId: string,
  channelId: string,
  definitionId: string,
): Promise<InvitedAgent> {
  return request(
    `/api/tenants/${tenantId}/chat/channels/${channelId}/invite`,
    InvitedAgent,
    { method: "POST", body: JSON.stringify({ definitionId }) },
  );
}

// `GET /channels/:id/agents` (see `packages/chat/src/routes.ts`): every
// one of the channel's agent participants, each resolved to the
// definition id its name/instructions are read from and saved to via
// `@corbits/agent-directory`'s own routes (see `getAgentInstructions`/
// `updateAgentInstructions` below). A channel with several invited
// agents lists all of them, not just the first.
const ChannelAgentWire = type({
  address: "string",
  handle: "string",
  definitionId: "string",
});
export type ChannelAgent = typeof ChannelAgentWire.infer;

const ChannelAgentsResponse = type({ items: ChannelAgentWire.array() });

export function listChannelAgents(
  tenantId: string,
  channelId: string,
): Promise<readonly ChannelAgent[]> {
  return request(
    `/api/tenants/${tenantId}/chat/channels/${channelId}/agents`,
    ChannelAgentsResponse,
  ).then((page) => page.items);
}

// `POST /channels/:id/agents/refresh` (see
// `packages/chat/src/routes.ts`): recomputes the given agent's running
// instance from its definition's CURRENT instructions — a wake replays
// whatever the channel's launch record holds verbatim, so a definition
// edit reaches a running instance only after this call. The Assistant
// section calls it right after `updateAgentInstructions` succeeds, so
// the change is live for this channel's agent from its next reply.
export function refreshChannelAgent(
  tenantId: string,
  channelId: string,
  address: string,
): Promise<void> {
  return request(
    `/api/tenants/${tenantId}/chat/channels/${channelId}/agents/refresh`,
    type({ ok: "boolean" }),
    { method: "POST", body: JSON.stringify({ address }) },
  ).then(() => undefined);
}

// `GET`/`PUT /api/tenants/:t/agent-definitions/:id` (see
// `packages/agent-directory/src/routes.ts`): an agent's editable
// persona — its display name and system prompt (surfaced to a person as
// "instructions"). `name` here is the display name, matching the create
// form's own "name" field (see `CreateAgentDefinitionInput`), never the
// definition's immutable handle.
const AgentInstructionsWire = type({
  name: "string",
  systemPrompt: "string",
});
export type AgentInstructions = typeof AgentInstructionsWire.infer;

function agentInstructionsPath(tenantId: string, definitionId: string) {
  return `/api/tenants/${tenantId}/agent-definitions/${encodeURIComponent(definitionId)}`;
}

export function getAgentInstructions(
  tenantId: string,
  definitionId: string,
): Promise<AgentInstructions> {
  return request(
    agentInstructionsPath(tenantId, definitionId),
    AgentInstructionsWire,
  );
}

export function updateAgentInstructions(
  tenantId: string,
  definitionId: string,
  input: AgentInstructions,
): Promise<AgentInstructions> {
  return request(
    agentInstructionsPath(tenantId, definitionId),
    AgentInstructionsWire,
    { method: "PUT", body: JSON.stringify(input) },
  );
}

export function channelStreamUrl(tenantId: string, channelId: string): string {
  return `/api/tenants/${tenantId}/chat/channels/${channelId}/stream`;
}

// `POST`/`GET .../blocks/:blockId/responses` (see
// `packages/chat/src/routes.ts`): the poll/form round-trip. `own` is only
// ever this signed-in principal's own response — a poll's `tally` is the
// one place another principal's participation shows up at all, and only as
// an anonymous count, never whose it was.
const BlockResponsePayloadWire = type({
  kind: "'poll'",
  choiceIds: "string[]",
}).or(type({ kind: "'form'", values: "Record<string, string>" }));
export type BlockResponsePayload = typeof BlockResponsePayloadWire.infer;

const BlockResponsesWire = type({
  tally: "Record<string, number>",
  total: "number",
  own: BlockResponsePayloadWire.or("null"),
});
export type BlockResponses = typeof BlockResponsesWire.infer;

const SubmittedBlockResponse = type({
  blockId: "string",
  updatedAt: "string",
});

function blockResponsesPath(
  tenantId: string,
  channelId: string,
  messageId: string,
  blockId: string,
): string {
  return (
    `/api/tenants/${tenantId}/chat/channels/${channelId}/messages/` +
    `${messageId}/blocks/${blockId}/responses`
  );
}

export function getBlockResponses(
  tenantId: string,
  channelId: string,
  messageId: string,
  blockId: string,
): Promise<BlockResponses> {
  return request(
    blockResponsesPath(tenantId, channelId, messageId, blockId),
    BlockResponsesWire,
  );
}

export function submitPollResponse(
  tenantId: string,
  channelId: string,
  messageId: string,
  blockId: string,
  choiceIds: readonly string[],
): Promise<void> {
  return request(
    blockResponsesPath(tenantId, channelId, messageId, blockId),
    SubmittedBlockResponse,
    {
      method: "POST",
      body: JSON.stringify({ kind: "poll", choiceIds }),
    },
  ).then(() => undefined);
}

export function submitFormResponse(
  tenantId: string,
  channelId: string,
  messageId: string,
  blockId: string,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  return request(
    blockResponsesPath(tenantId, channelId, messageId, blockId),
    SubmittedBlockResponse,
    {
      method: "POST",
      body: JSON.stringify({ kind: "form", values }),
    },
  ).then(() => undefined);
}

// `chat/contextWindow`'s two-way "inherit vs override" resolution — see
// `resolveContextWindow` in `packages/chat/src/channel-settings.ts`, whose
// server-side output this wire shape mirrors. `source` is what the settings
// panel's "Use bench default (N)" vs override control reads to decide which
// state it renders.
export const ResolvedContextWindow = type({
  value: "number",
  source: "'inherit' | 'override'",
});
export type ResolvedContextWindow = typeof ResolvedContextWindow.infer;

const ChannelSettingsResponse = ChannelWire.and({
  settings: type("Record<string, unknown>"),
  contextWindow: ResolvedContextWindow,
}).pipe((wire) => ({
  ...wire,
  participants: parseParticipants(wire.participants),
}));
export type ChannelSettings = Omit<
  typeof ChannelSettingsResponse.infer,
  "participants"
> & {
  readonly participants: readonly ParticipantRecord[];
};

export function getChannelSettings(
  tenantId: string,
  channelId: string,
): Promise<ChannelSettings> {
  return request(
    `/api/tenants/${tenantId}/chat/channels/${channelId}/settings`,
    ChannelSettingsResponse,
  );
}

/**
 * A `chat/*`-namespaced settings patch: name, purpose, pinned, and
 * context-window edits all go through this one function, matching the
 * single `PATCH /channels/:id/settings` route in
 * `packages/chat/src/routes.ts` that accepts any subset of them in one
 * body. `chat/contextWindow: null` clears
 * a channel's override back to inheriting the bench default.
 */
export type ChannelSettingsPatch = {
  readonly "chat/kind"?: string;
  readonly "chat/name"?: string;
  readonly "chat/purpose"?: string;
  readonly "chat/pinned"?: boolean;
  readonly "chat/contextWindow"?: number | null;
};

export function patchChannelSettings(
  tenantId: string,
  channelId: string,
  patch: ChannelSettingsPatch,
): Promise<ChannelSettings> {
  return request(
    `/api/tenants/${tenantId}/chat/channels/${channelId}/settings`,
    ChannelSettingsResponse,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}

// `GET`/`PATCH /bench/settings` (see `packages/chat/src/routes.ts`): the
// bench-wide chat defaults every channel inherits unless it sets its own
// override. Currently just the default context window.
const BenchChatSettingsResponse = type({
  settings: "Record<string, unknown>",
  contextWindow: "number",
});
export type BenchChatSettings = typeof BenchChatSettingsResponse.infer;

export function getBenchChatSettings(
  tenantId: string,
): Promise<BenchChatSettings> {
  return request(
    `/api/tenants/${tenantId}/chat/bench/settings`,
    BenchChatSettingsResponse,
  );
}

export type BenchChatSettingsPatch = {
  readonly "chat/contextWindow": number;
};

export function patchBenchChatSettings(
  tenantId: string,
  patch: BenchChatSettingsPatch,
): Promise<BenchChatSettings> {
  return request(
    `/api/tenants/${tenantId}/chat/bench/settings`,
    BenchChatSettingsResponse,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}

/**
 * A readable name for a run, since the runs listing carries no name field:
 * the asset id's final path segment with any extension stripped, e.g.
 * `researcher/workflow.json` → "workflow". An asset id with no path shape
 * at all carries no readable segment to extract, so it renders friendly
 * placeholder copy — never the raw asset id.
 */
export function runDisplayName(run: Run): string {
  const slash = run.definitionAssetId.lastIndexOf("/");
  if (slash < 0) return CHAT_STRINGS.unnamedRun;
  const segment = run.definitionAssetId.slice(slash + 1);
  if (segment.length === 0) return CHAT_STRINGS.unnamedRun;
  const dot = segment.lastIndexOf(".");
  return dot > 0 ? segment.slice(0, dot) : segment;
}
