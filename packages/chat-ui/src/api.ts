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

export const MessageSender = type({ name: "string | null", address: "string" });
export type MessageSender = typeof MessageSender.infer;

const MessageItem = type({
  id: "string",
  createdAt: "string",
  parts: Part.array(),
  sender: MessageSender,
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
const InvitableDefinition = type({ id: "string", name: "string" });
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
      `The hub answered ${response.status} for ${path}.`,
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

export const ChannelThread = type({
  id: "string",
  kind: "'root' | 'reply' | 'delivery'",
  parentMessageId: "string | null",
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
 * A `chat/*`-namespaced settings patch: name, pinned, and context-window
 * edits all go through this one function, matching the single `PATCH
 * /channels/:id/settings` route in `packages/chat/src/routes.ts` that
 * accepts any subset of them in one body. `chat/contextWindow: null` clears
 * a channel's override back to inheriting the bench default.
 */
export type ChannelSettingsPatch = {
  readonly "chat/name"?: string;
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
