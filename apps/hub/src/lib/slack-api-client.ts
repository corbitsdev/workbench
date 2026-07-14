import { type } from "arktype";
import { getLogger } from "@intx/log";
import { resolveCredentialRequirement } from "@intx/db";
import type { HubDb } from "../db";
import { decryptToolCredentialSecret } from "./credential-crypto";

const log = getLogger(["lib", "slack-api-client"]);

const SLACK_PROVIDER_NAME = "slack";
const DEFAULT_BASE_URL = "https://slack.com/api";

export interface SlackCredential {
  botToken: string;
  baseUrl: string;
}

// The subset of a provider's metadata this resolver reads. `+: "ignore"` keeps
// any other keys, so an unrelated metadata shape still parses.
const ProviderMetadataSchema = type({
  "baseURL?": "string",
  "+": "ignore",
});

/**
 * Resolve the tenant-owned Slack bot token (CREDENTIAL_PROVIDER_CATALOG
 * `slack` entry, `kind: "tool"`). Returns null when the tenant has not
 * configured Slack — callers treat that as "nothing to do for this tenant",
 * never an error.
 */
export async function resolveSlackCredential(
  db: HubDb,
  tenantId: string,
): Promise<SlackCredential | null> {
  const resolved = await resolveCredentialRequirement(
    db,
    tenantId,
    { providerName: SLACK_PROVIDER_NAME, source: "tenant" },
    null,
    null,
  );
  if (!resolved) return null;
  const providerRow = await db.query.provider.findFirst({
    where: (p, { eq }) => eq(p.id, resolved.providerId),
  });
  const parsed = ProviderMetadataSchema(providerRow?.metadata ?? {});
  const baseUrl =
    parsed instanceof type.errors
      ? DEFAULT_BASE_URL
      : (parsed.baseURL ?? DEFAULT_BASE_URL);
  return {
    botToken: decryptToolCredentialSecret(resolved.secret),
    baseUrl,
  };
}

const SlackEnvelope = type({
  ok: "boolean",
  "error?": "string",
});

/** A minimal, typed Slack Web API POST caller. Deliberately independent of
 * `@workbench/tools-slack` (that package's `slackCall` is not exported, and
 * this client needs methods — `users.info`, `conversations.join`,
 * `chat.getPermalink` — that package does not implement). */
async function slackApiCall(
  credential: SlackCredential,
  method: string,
  params: Record<string, string>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const url = `${credential.baseUrl.replace(/\/$/, "")}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential.botToken}`,
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    body: new URLSearchParams(params).toString(),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Slack ${method} HTTP error: ${response.status}`);
  }
  const data: unknown = await response.json();
  const envelope = SlackEnvelope(data);
  if (envelope instanceof type.errors) {
    throw new Error(`Slack ${method} returned an unexpected shape`);
  }
  if (!envelope.ok) {
    throw new Error(`Slack ${method} error: ${envelope.error ?? "unknown"}`);
  }
  return data as Record<string, unknown>;
}

const SlackUserInfoResponse = type({
  ok: "boolean",
  "user?": type({
    id: "string",
    "profile?": type({ "email?": "string | null" }),
  }),
});

/** Fetch a single Slack user's account email via `users.info`. Returns null
 * when the user has no email on file (bots, restricted accounts) — never
 * guessed. */
export async function fetchSlackUserEmail(
  credential: SlackCredential,
  slackUserId: string,
  signal: AbortSignal,
): Promise<string | null> {
  const data = await slackApiCall(
    credential,
    "users.info",
    { user: slackUserId },
    signal,
  );
  const parsed = SlackUserInfoResponse(data);
  if (parsed instanceof type.errors) {
    log.warn("slack users.info returned an unexpected shape", {
      slackUserId,
    });
    return null;
  }
  return parsed.user?.profile?.email ?? null;
}

const SlackChannel = type({
  id: "string",
  "name?": "string",
  "is_member?": "boolean",
  "is_private?": "boolean",
});
export type SlackChannel = typeof SlackChannel.infer;

const SlackConversationsListResponse = type({
  ok: "boolean",
  "channels?": SlackChannel.array(),
  "response_metadata?": type({ "next_cursor?": "string" }),
});

/** List every public channel in the workspace, paginating conversations.list
 * to exhaustion. Bounded to 50 pages (5,000 channels at the max page size) so
 * a pathological cursor loop cannot spin forever. */
export async function listAllPublicChannels(
  credential: SlackCredential,
  signal: AbortSignal,
): Promise<SlackChannel[]> {
  const channels: SlackChannel[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const params: Record<string, string> = {
      types: "public_channel",
      exclude_archived: "true",
      limit: "200",
    };
    if (cursor) params.cursor = cursor;
    const data = await slackApiCall(
      credential,
      "conversations.list",
      params,
      signal,
    );
    const parsed = SlackConversationsListResponse(data);
    if (parsed instanceof type.errors) {
      throw new Error("Slack conversations.list returned an unexpected shape");
    }
    channels.push(...(parsed.channels ?? []));
    cursor = parsed.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return channels;
}

/** Join a public channel by id. Slack returns `ok: true` idempotently when
 * the bot is already a member, so this is safe to call unconditionally. */
export async function joinChannel(
  credential: SlackCredential,
  channelId: string,
  signal: AbortSignal,
): Promise<void> {
  await slackApiCall(
    credential,
    "conversations.join",
    { channel: channelId },
    signal,
  );
}

const SlackPermalinkResponse = type({
  ok: "boolean",
  "permalink?": "string",
});

/** Resolve a message's permalink via `chat.getPermalink`. Returns null on
 * failure (e.g. the message already scrolled out of retention) rather than
 * throwing — a missing permalink must not block delivering the mention. */
export async function fetchMessagePermalink(
  credential: SlackCredential,
  channelId: string,
  messageTs: string,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const data = await slackApiCall(
      credential,
      "chat.getPermalink",
      { channel: channelId, message_ts: messageTs },
      signal,
    );
    const parsed = SlackPermalinkResponse(data);
    if (parsed instanceof type.errors) return null;
    return parsed.permalink ?? null;
  } catch (err) {
    log.debug("slack chat.getPermalink failed; delivering without a link", {
      channelId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return null;
  }
}
