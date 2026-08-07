// The chat surface's one seam to `@corbits/chat`'s HTTP routes (see
// packages/chat/src/routes.ts). Every fetch the chat/* components make goes
// through a function here, and every response is parsed with an arktype
// schema at the boundary — a route shape change is a one-file fix.
//
// The `Part` schema is defined locally rather than imported from
// `packages/chat`: that package is under active development elsewhere, and a
// wire contract this app parses untrusted data against should not shift out
// from under it mid-edit. It is kept structurally identical to
// `packages/chat/src/parts.ts` on purpose.

import { type } from "arktype";
import type { ArkErrors } from "arktype";

export const TextPart = type({ kind: "'text'", text: "string" });
export const ReasoningPart = type({ kind: "'reasoning'", text: "string" });
export const ToolTracePart = type({
  kind: "'tool-trace'",
  name: "string",
  input: "unknown",
  "output?": "unknown",
  status: "'pending' | 'running' | 'success' | 'error'",
});
export const BlockPart = type({
  kind: "'block'",
  block: { type: "string", data: "unknown" },
});
export const FilePart = type({
  kind: "'file'",
  name: "string",
  mediaType: "string",
  "blobId?": "string",
  "data?": "string",
});
export const EventPart = type({
  kind: "'event'",
  event: "string",
  data: "unknown",
});

export const Part = TextPart.or(ReasoningPart)
  .or(ToolTracePart)
  .or(BlockPart)
  .or(FilePart)
  .or(EventPart);
export type Part = typeof Part.infer;

export const ChannelKind = type("'channel' | 'chat'");
export type ChannelKind = typeof ChannelKind.infer;

// A channel participant's mention-friendly record — an address plus the
// short handle a mention actually types (`@echo`), never the raw
// instance-id local part. Mirrors `@corbits/chat`'s `ParticipantRecord`
// (see `packages/chat/src/participants.ts`) structurally, kept local for
// the same reason `Part` is above: this wire contract should not shift
// out from under the app mid-edit of that package.
export const ParticipantRecord = type({
  address: "string",
  handle: "string",
});
export type ParticipantRecord = typeof ParticipantRecord.infer;

const Channel = type({
  id: "string",
  title: "string",
  kind: "string",
  pinned: "boolean",
  participants: ParticipantRecord.array(),
});
export type Channel = typeof Channel.infer;

const ChannelsResponse = type({ items: Channel.array() });

// `sender` is landing on `GET /channels/:id/messages` in packages/chat
// alongside this change (see routes.ts) — kept optional here so the UI
// tolerates responses from either side of that rollout.
export const MessageSender = type({ name: "string | null", address: "string" });
export type MessageSender = typeof MessageSender.infer;

const MessageItem = type({
  id: "string",
  createdAt: "string",
  parts: Part.array(),
  "sender?": MessageSender,
});
export type MessageItem = typeof MessageItem.infer;

const MessagesResponse = type({
  items: MessageItem.array(),
  "nextCursor?": "string",
});
export type MessagesResponse = typeof MessagesResponse.infer;

const SentMessage = type({ id: "string", createdAt: "string" });

const ReadState = type({
  "lastSeenCreatedAt?": "string | null",
  "lastSeenId?": "string | null",
});

// The shape `GET /api/tenants/:t/workflows/instances` returns (see
// vendor/intx/hub-api/src/routes/workflows.ts): a deployed workflow, one row
// per deployment. It carries no display name — only the id and the asset id
// its definition was hydrated from — so the mention popover derives a
// readable label from `definitionAssetId` (see `deploymentDisplayName`
// below) until the platform exposes a real name here.
const Deployment = type({
  id: "string",
  tenantId: "string",
  definitionAssetId: "string",
  status: "string",
  createdAt: "string",
});
export type Deployment = typeof Deployment.infer;

const DeploymentsResponse = Deployment.array();

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

// A chat is a single-agent direct thread: the agent is picked at creation
// via `definitionId` and the name is optional (the server titles it by the
// agent's handle when omitted). A channel is the pinned, multiplayer kind:
// name-only, no agent attached at creation. See `packages/chat/src/routes.ts`
// `POST /channels` for the server side of this union.
export type CreateChannelInput =
  | { readonly kind: "channel"; readonly name: string }
  | {
      readonly kind: "chat";
      readonly definitionId: string;
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

export function sendMessage(
  tenantId: string,
  channelId: string,
  parts: readonly Part[],
): Promise<{ readonly id: string; readonly createdAt: string }> {
  return request(
    `/api/tenants/${tenantId}/chat/channels/${channelId}/messages`,
    SentMessage,
    { method: "POST", body: JSON.stringify(parts) },
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

export function listDeployedAgents(
  tenantId: string,
): Promise<readonly Deployment[]> {
  return request(
    `/api/tenants/${tenantId}/workflows/instances`,
    DeploymentsResponse,
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

/**
 * A readable name for a deployment, since the deployments listing carries no
 * name field: the asset id's final path segment with any extension
 * stripped, e.g. `researcher/workflow.json` → "workflow", falling back to
 * the raw asset id when it has no path shape at all.
 */
export function deploymentDisplayName(deployment: Deployment): string {
  const segment = deployment.definitionAssetId.split("/").at(-1);
  if (segment === undefined || segment.length === 0) {
    return deployment.definitionAssetId;
  }
  const dot = segment.lastIndexOf(".");
  return dot > 0 ? segment.slice(0, dot) : segment;
}
