import { createHmac, timingSafeEqual } from "node:crypto";
import { type } from "arktype";
import { Hono } from "hono";
import { getLogger } from "@intx/log";
import { resolveEnabledInboxSources } from "@workbench/shared";
import type { HubDb } from "../db";
import {
  deliverInboxItems,
  type InboxDeliveryDeps,
  type InboxDeliveryTarget,
} from "../lib/inbox-delivery";
import { readMemberPreferences } from "../lib/member-preferences";
import type { MailboxEventBus } from "../lib/mailbox-events";
import type { MailboxTriage } from "../services/mailbox-triage";
import {
  fetchMessagePermalink,
  fetchSlackUserEmail,
  resolveSlackCredential,
  type SlackCredential,
} from "../lib/slack-api-client";
import { joinNewlyCreatedChannel } from "../lib/slack-channel-autojoin";
import {
  createSlackEventDedupe,
  type SlackEventDedupe,
} from "../lib/slack-event-dedupe";
import {
  createEmailMemberResolver,
  type SlackMemberResolver,
} from "../lib/slack-member-mapping";
import { resolveTenantForSlackTeam } from "../lib/slack-team-mapping";
import type { InboxIntakeMember } from "../services/inbox-source-registry";

const log = getLogger(["routes", "webhooks-slack"]);

const SOURCE_KEY = "slack";
// Slack's own recommendation: reject requests whose X-Slack-Request-Timestamp
// is more than five minutes old (replay protection).
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;
const MAX_BODY_BYTES = 256 * 1024;

const SlackEnvelope = type({
  type: "string",
  "challenge?": "string",
  "team_id?": "string",
  "event_id?": "string",
  "event?": "unknown",
});

const MessageEvent = type({
  type: "'message'",
  "subtype?": "string",
  channel: "string",
  "user?": "string",
  "text?": "string",
  ts: "string",
  "bot_id?": "string",
});

const ChannelCreatedEvent = type({
  type: "'channel_created'",
  channel: type({ id: "string", "name?": "string" }),
});

const MENTION_PATTERN = /<@([A-Z0-9]+)>/g;

export interface SlackWebhookDeps {
  db: HubDb;
  /** The signing secret configured for this Slack app (Basic Information →
   * App Credentials → Signing Secret). */
  signingSecret: string;
  /** Enumerate the members an event can be routed to (email → inbox). */
  listMembers: () => Promise<InboxIntakeMember[]>;
  /** Owner cascade: whether the source is enabled for the tenant. */
  isSourceEnabledForTenant: (
    tenantId: string,
    sourceKey: string,
  ) => Promise<boolean>;
  /** Resolve the tenant's Slack bot token. Defaults to
   * `resolveSlackCredential` against `deps.db`; overridable in tests. */
  resolveCredential?: (tenantId: string) => Promise<SlackCredential | null>;
  /** Overridable for tests; defaults to an email-mapping resolver built from
   * `listMembers` + `resolveCredential`. */
  memberResolver?: SlackMemberResolver;
  /** Overridable for tests; defaults to a fresh in-memory dedupe cache. */
  dedupe?: SlackEventDedupe;
  /** Resolve a Slack workspace's `team_id` to the tenant that enabled it
   * (CL-3629). Defaults to `resolveTenantForSlackTeam` against `deps.db`;
   * overridable in tests. Returns null for an unmapped team. */
  resolveTenantForTeam?: (teamId: string) => Promise<string | null>;
  mailboxEventBus?: MailboxEventBus;
  mailboxTriage?: Pick<MailboxTriage, "enqueue">;
}

/** Constant-time compare of two Slack `v0=<hex>` signatures. Any
 * length/format mismatch is a non-match rather than a throw. */
function signatureMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function verifySignature(args: {
  signingSecret: string;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  rawBody: string;
}): boolean {
  const { signingSecret, timestampHeader, signatureHeader, rawBody } = args;
  if (!timestampHeader || !signatureHeader) return false;

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return false;
  const skewSeconds = Math.abs(Date.now() / 1000 - timestamp);
  if (skewSeconds > TIMESTAMP_TOLERANCE_SECONDS) return false;

  const base = `v0:${timestampHeader}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
  return signatureMatches(expected, signatureHeader);
}

/**
 * Public Slack Events API receiver (CL-3581). Mounted only when
 * `SLACK_SIGNING_SECRET` is set. Verifies `X-Slack-Signature` (v0 HMAC-SHA256
 * over `v0:{timestamp}:{rawBody}`) BEFORE any JSON parsing, rejects a stale
 * timestamp (replay guard), echoes the `url_verification` challenge, and —
 * for `message` events on public channels — scans the text for `<@USERID>`
 * mentions, resolves each mentioned Slack user to a Workbench member by
 * email, and delivers a mailbox row + triage handoff for each match.
 *
 * Manual setup (Slack app config → Event Subscriptions): Request URL
 * `https://<hub-host>/webhooks/slack`, subscribe to bot events
 * `message.channels` and `channel_created`, and copy the app's Signing
 * Secret into `SLACK_SIGNING_SECRET`. The bot also needs the `channels:history`,
 * `channels:join`, `users:read`, and `users:read.email` OAuth scopes, and its
 * bot token seeded as the `slack` tool credential.
 */
export function createSlackWebhookRouter(deps: SlackWebhookDeps): Hono {
  const app = new Hono();
  const dedupe = deps.dedupe ?? createSlackEventDedupe();
  const resolveCredential =
    deps.resolveCredential ??
    ((tenantId: string) => resolveSlackCredential(deps.db, tenantId));
  const memberResolver =
    deps.memberResolver ??
    createEmailMemberResolver({
      listMembers: deps.listMembers,
      lookupEmail: async (tenantId, slackUserId, signal) => {
        const credential = await resolveCredential(tenantId);
        if (!credential) return null;
        return fetchSlackUserEmail(credential, slackUserId, signal);
      },
    });
  const resolveTenantForTeam =
    deps.resolveTenantForTeam ??
    ((teamId: string) => resolveTenantForSlackTeam(deps.db, teamId));

  app.post("/webhooks/slack", async (c) => {
    const signature = c.req.header("x-slack-signature");
    const timestamp = c.req.header("x-slack-request-timestamp");

    const contentLength = c.req.header("content-length");
    if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
      return c.json({ error: "payload too large" }, 413);
    }

    const rawBody = await c.req.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return c.json({ error: "payload too large" }, 413);
    }

    if (
      !verifySignature({
        signingSecret: deps.signingSecret,
        timestampHeader: timestamp,
        signatureHeader: signature,
        rawBody,
      })
    ) {
      log.warn("slack webhook: signature verification failed; rejecting");
      return c.json({ error: "invalid signature" }, 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }

    const envelope = SlackEnvelope(payload);
    if (envelope instanceof type.errors) {
      return c.json({ error: "unrecognized payload" }, 400);
    }

    if (envelope.type === "url_verification") {
      if (!envelope.challenge) {
        return c.json({ error: "missing challenge" }, 400);
      }
      return c.json({ challenge: envelope.challenge }, 200);
    }

    if (envelope.type === "event_callback") {
      if (!envelope.event_id || !dedupe.shouldProcess(envelope.event_id)) {
        // Already processed (or missing an id to dedupe on) — ack without
        // reprocessing so Slack's at-least-once retry does not double-file.
        return c.json({ ok: true }, 200);
      }
      if (!envelope.team_id) {
        log.debug("slack webhook: event_callback missing team_id; dropping");
        return c.json({ ok: true }, 200);
      }
      await handleEvent(
        { deps, memberResolver, resolveCredential, resolveTenantForTeam },
        envelope.team_id,
        envelope.event,
      );
      return c.json({ ok: true }, 200);
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}

interface EventHandlerCtx {
  deps: SlackWebhookDeps;
  memberResolver: SlackMemberResolver;
  resolveCredential: (tenantId: string) => Promise<SlackCredential | null>;
  resolveTenantForTeam: (teamId: string) => Promise<string | null>;
}

async function handleEvent(
  ctx: EventHandlerCtx,
  teamId: string,
  event: unknown,
): Promise<void> {
  const channelCreated = ChannelCreatedEvent(event);
  if (!(channelCreated instanceof type.errors)) {
    await handleChannelCreated(ctx, teamId, channelCreated.channel.id);
    return;
  }

  const message = MessageEvent(event);
  if (message instanceof type.errors) return;
  // A bot's own message or a system subtype (message_changed, etc.) carries
  // no human mention worth routing.
  if (message.bot_id || message.subtype) return;
  if (!message.user || !message.text) return;

  const mentionedUserIds = new Set<string>();
  for (const match of message.text.matchAll(MENTION_PATTERN)) {
    const userId = match[1];
    if (userId) mentionedUserIds.add(userId);
  }
  if (mentionedUserIds.size === 0) return;

  for (const slackUserId of mentionedUserIds) {
    await routeMention(ctx, teamId, slackUserId, message);
  }
}

async function handleChannelCreated(
  ctx: EventHandlerCtx,
  teamId: string,
  channelId: string,
): Promise<void> {
  const tenantId = await ctx.resolveTenantForTeam(teamId);
  if (!tenantId) {
    log.debug("slack webhook: channel_created for an unmapped team; dropping", {
      teamId,
    });
    return;
  }
  if (!(await ctx.deps.isSourceEnabledForTenant(tenantId, SOURCE_KEY))) return;
  const credential = await ctx.resolveCredential(tenantId);
  if (!credential) return;
  await joinNewlyCreatedChannel(
    credential,
    channelId,
    new AbortController().signal,
  );
}

/**
 * Resolves the event's workspace to its mapped tenant (CL-3629) and routes
 * to that tenant only — an unmapped team (no owner has enabled Slack and
 * completed the auth.test handshake, or the workspace was never enabled) is
 * dropped with a debug log rather than fanned out across every tenant.
 */
async function routeMention(
  ctx: EventHandlerCtx,
  teamId: string,
  slackUserId: string,
  message: typeof MessageEvent.infer,
): Promise<void> {
  const tenantId = await ctx.resolveTenantForTeam(teamId);
  if (!tenantId) {
    log.debug("slack webhook: event from an unmapped team; dropping", {
      teamId,
    });
    return;
  }

  let ownerEnabled: boolean;
  try {
    ownerEnabled = await ctx.deps.isSourceEnabledForTenant(
      tenantId,
      SOURCE_KEY,
    );
  } catch {
    ownerEnabled = false;
  }
  if (!ownerEnabled) return;

  const signal = new AbortController().signal;
  const member = await ctx.memberResolver.resolveMember(
    tenantId,
    slackUserId,
    signal,
  );
  if (!member) {
    log.debug(
      "slack webhook: no member matches the mentioned slack user; dropping",
      { slackUserId },
    );
    return;
  }

  // Member-level gate (CL-3581): the owner cascade above is the ceiling,
  // not the floor — a mention still requires the member's own
  // `inboxSource:slack` preference, default OFF like every inbox source.
  // Slack has no member OAuth credential to gate on (unlike Linear/Attio),
  // so this is a pure preference read, mirroring how the intake tick gates
  // member sources without requiring a credential the member can't have.
  let slackEnabled: boolean;
  try {
    const prefs = await readMemberPreferences(
      ctx.deps.db,
      tenantId,
      member.memberPrincipalId,
    );
    slackEnabled = resolveEnabledInboxSources(prefs).includes(SOURCE_KEY);
  } catch {
    slackEnabled = false;
  }
  if (!slackEnabled) return;

  await deliverMention(ctx, teamId, member, message);
}

async function deliverMention(
  ctx: EventHandlerCtx,
  teamId: string,
  member: InboxIntakeMember,
  message: typeof MessageEvent.infer,
): Promise<void> {
  // Permalink fetch is Slack-specific (needs the tenant's bot credential) and
  // has no equivalent in the shared delivery seam, so it stays local; the
  // resulting subject/body/externalId are then handed to `deliverInboxItems`
  // like every other source.
  const credential = await ctx.resolveCredential(member.tenantId);
  const permalink = credential
    ? await fetchMessagePermalink(
        credential,
        message.channel,
        message.ts,
        new AbortController().signal,
      )
    : null;

  const subject = `You were mentioned in Slack #${message.channel}`;
  const bodyLines = [message.text ?? ""];
  if (permalink) bodyLines.push("", permalink);
  const body = bodyLines.join("\n");
  // Preserves the pre-CL-3577-overhaul messageKey format
  // (`inbox:slack:<teamId>:<channel>:<ts>`) so already-delivered mentions do
  // not re-deliver when routed through the shared helper.
  const externalId = `${teamId}:${message.channel}:${message.ts}`;

  const target: InboxDeliveryTarget = member;
  const deliveryDeps: InboxDeliveryDeps = {
    db: ctx.deps.db,
    ...(ctx.deps.mailboxEventBus
      ? { mailboxEventBus: ctx.deps.mailboxEventBus }
      : {}),
    ...(ctx.deps.mailboxTriage
      ? { mailboxTriage: ctx.deps.mailboxTriage }
      : {}),
  };
  await deliverInboxItems(deliveryDeps, target, SOURCE_KEY, [
    { externalId, subject, body, url: permalink ?? "" },
  ]);
}
