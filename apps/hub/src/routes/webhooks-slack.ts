import { createHmac, timingSafeEqual } from "node:crypto";
import { type } from "arktype";
import { Hono } from "hono";
import { getLogger } from "@intx/log";
import type { HubDb } from "../db";
import { buildMailFrame, writeMailboxMessage } from "../lib/mailbox-write";
import type { MailboxEventBus } from "../lib/mailbox-events";
import type { MailboxTriage } from "../services/mailbox-triage";
import type { UserMailboxRowEvent } from "../lib/principal-mailbox";
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
        { deps, memberResolver, resolveCredential },
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
  const tenantId = await firstEnabledTenant(ctx, teamId);
  if (!tenantId) return;
  const credential = await ctx.resolveCredential(tenantId);
  if (!credential) return;
  await joinNewlyCreatedChannel(
    credential,
    channelId,
    new AbortController().signal,
  );
}

/**
 * Every tenant that has enrolled Slack members is a candidate for this
 * event's workspace — there is no persisted Slack-team→tenant mapping yet
 * (out of scope for CL-3581; see the final report's assumptions). The first
 * tenant whose Slack source is owner-enabled is treated as the event's home
 * tenant for workspace-scoped actions (auto-join).
 */
async function firstEnabledTenant(
  ctx: EventHandlerCtx,
  _teamId: string,
): Promise<string | null> {
  const members = await ctx.deps.listMembers();
  const tenantIds = [...new Set(members.map((m) => m.tenantId))];
  for (const tenantId of tenantIds) {
    if (await ctx.deps.isSourceEnabledForTenant(tenantId, SOURCE_KEY)) {
      return tenantId;
    }
  }
  return null;
}

async function routeMention(
  ctx: EventHandlerCtx,
  teamId: string,
  slackUserId: string,
  message: typeof MessageEvent.infer,
): Promise<void> {
  const members = await ctx.deps.listMembers();
  const tenantIds = [...new Set(members.map((m) => m.tenantId))];

  for (const tenantId of tenantIds) {
    let ownerEnabled: boolean;
    try {
      ownerEnabled = await ctx.deps.isSourceEnabledForTenant(
        tenantId,
        SOURCE_KEY,
      );
    } catch {
      ownerEnabled = false;
    }
    if (!ownerEnabled) continue;

    const signal = new AbortController().signal;
    const member = await ctx.memberResolver.resolveMember(
      tenantId,
      slackUserId,
      signal,
    );
    if (!member) continue;

    // NOTE (CL-3581 wiring gap): there is deliberately no per-member
    // `inboxSource:slack` preference check here. `INBOX_SOURCE_CATALOG` in
    // `packages/workbench-shared/src/preferences-registry.ts` only derives an
    // inbox-source entry for a `CREDENTIAL_PROVIDER_CATALOG` row that also
    // sets `briefSource` (Slack rightly has none — it is not a brief source).
    // That file was mid-edit by another agent this session and is off-limits
    // here; see the final report's wiring instructions for the one-line
    // filter change (`briefSource !== undefined || inboxSource !== undefined`)
    // that unlocks a real member-level toggle. Until then this route is
    // gated on the owner (tenant) cascade only, same as Linear/Attio's tenant
    // ceiling.
    await deliverMention(ctx, teamId, member, message);
    return;
  }

  log.debug(
    "slack webhook: no member matches the mentioned slack user; dropping",
    { slackUserId },
  );
}

async function deliverMention(
  ctx: EventHandlerCtx,
  teamId: string,
  member: InboxIntakeMember,
  message: typeof MessageEvent.infer,
): Promise<void> {
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
  const fromAddress = `${SOURCE_KEY}@${member.tenantDomain}`;
  const messageKey = `inbox:${SOURCE_KEY}:${teamId}:${message.channel}:${message.ts}`;

  const written = await writeMailboxMessage(
    ctx.deps.db,
    {
      tenantId: member.tenantId,
      principalId: member.memberPrincipalId,
      address: member.inboxAddress,
      fromAddress,
      subject,
      body,
      messageKey,
    },
    ctx.deps.mailboxEventBus,
  );
  if (!written) return; // already delivered (dedupe)

  if (ctx.deps.mailboxTriage) {
    const event: UserMailboxRowEvent = {
      rowId: written.id,
      tenantId: member.tenantId,
      memberPrincipalId: member.memberPrincipalId,
      recipientAddress: member.inboxAddress,
      senderAddress: fromAddress,
      subject,
      fromAddress,
      raw: buildMailFrame({
        from: fromAddress,
        to: member.inboxAddress,
        subject,
        body,
      }),
    };
    ctx.deps.mailboxTriage.enqueue(event);
  }
}
