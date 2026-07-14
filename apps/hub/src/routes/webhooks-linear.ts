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
import {
  buildCommentIntakeItem,
  buildIssueIntakeItem,
} from "../services/inbox-sources/linear";
import type { InboxIntakeMember } from "../services/inbox-source-registry";

const log = getLogger(["routes", "webhooks-linear"]);

const SOURCE_KEY = "linear";
// Linear's own recommendation: reject events whose webhookTimestamp is more
// than a minute from the time we see them (replay protection).
const TIMESTAMP_TOLERANCE_MS = 60_000;
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Linear webhook data-change envelope. Only the fields we act on are typed;
 * `data` is validated per-type below. `webhookTimestamp` is Unix ms.
 */
const WebhookEnvelope = type({
  action: "string",
  type: "string",
  "webhookTimestamp?": "number",
  data: "unknown",
});

const AssigneeRef = type({
  "email?": "string | null",
});

const IssueEventData = type({
  id: "string",
  identifier: "string",
  title: "string",
  url: "string",
  createdAt: "string",
  updatedAt: "string",
  "state?": type({ name: "string" }).or("null"),
  "assignee?": AssigneeRef.or("null"),
});

// A comment webhook carries the comment plus (when Linear inlines it) the
// parent issue with its assignee — the member the item is routed to.
const CommentEventData = type({
  id: "string",
  createdAt: "string",
  body: "string",
  "issue?": type({
    id: "string",
    identifier: "string",
    title: "string",
    url: "string",
    "assignee?": AssigneeRef.or("null"),
  }).or("null"),
});

export interface LinearWebhookDeps {
  db: HubDb;
  /** The HMAC-SHA256 signing secret configured for this Linear webhook. */
  secret: string;
  /** Enumerate the members an event can be routed to (email → inbox). */
  listMembers: () => Promise<InboxIntakeMember[]>;
  /** Owner cascade (CL-3584): whether the source is enabled for the tenant. */
  isSourceEnabledForTenant: (
    tenantId: string,
    sourceKey: string,
  ) => Promise<boolean>;
  mailboxEventBus?: InboxDeliveryDeps["mailboxEventBus"];
  mailboxTriage?: InboxDeliveryDeps["mailboxTriage"];
}

/** Constant-time compare of two hex-encoded HMAC digests. Any length/format
 * mismatch is a non-match rather than a throw. */
function signatureMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided, "hex");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Public Linear webhook receiver (CL-3585). Mounted only when
 * `LINEAR_WEBHOOK_SECRET` is set. It verifies the `linear-signature` HMAC over
 * the RAW body BEFORE parsing, then rejects stale timestamps (replay), then
 * routes Issue/Comment create/update events to the assignee's inbox using the
 * SAME `externalId` scheme as the poller — so a webhook delivery and a
 * subsequent poll of the same activity collapse to one mailbox row.
 *
 * Manual setup (Linear → Settings → API → Webhooks): create a webhook with URL
 * `https://<hub-host>/webhooks/linear`, subscribe to Issues and Comments, and
 * copy the signing secret into `LINEAR_WEBHOOK_SECRET`.
 */
export function createLinearWebhookRouter(deps: LinearWebhookDeps): Hono {
  const app = new Hono();

  app.post("/webhooks/linear", async (c) => {
    const signature = c.req.header("linear-signature");
    if (!signature) {
      log.warn("linear webhook: missing linear-signature header; rejecting");
      return c.json({ error: "missing signature" }, 401);
    }

    const contentLength = c.req.header("content-length");
    if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
      return c.json({ error: "payload too large" }, 413);
    }

    // Read the raw body and verify the signature BEFORE parsing JSON.
    const rawBody = await c.req.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return c.json({ error: "payload too large" }, 413);
    }
    const expected = createHmac("sha256", deps.secret)
      .update(rawBody)
      .digest("hex");
    if (!signatureMatches(expected, signature)) {
      log.warn("linear webhook: signature mismatch; rejecting");
      return c.json({ error: "invalid signature" }, 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }

    const envelope = WebhookEnvelope(payload);
    if (envelope instanceof type.errors) {
      return c.json({ error: "unrecognized payload" }, 400);
    }

    // Linear always sends `webhookTimestamp`; a signed payload missing it
    // would otherwise bypass the freshness check and could be replayed
    // indefinitely, so it is rejected the same as a stale one.
    if (envelope.webhookTimestamp === undefined) {
      log.warn(
        "linear webhook: missing webhookTimestamp; rejecting (replay guard)",
      );
      return c.json({ error: "missing timestamp" }, 401);
    }
    const skew = Math.abs(Date.now() - envelope.webhookTimestamp);
    if (skew > TIMESTAMP_TOLERANCE_MS) {
      log.warn("linear webhook: stale timestamp; rejecting (replay guard)", {
        skewMs: skew,
      });
      return c.json({ error: "stale timestamp" }, 401);
    }

    await handleEvent(deps, envelope.action, envelope.type, envelope.data);
    // Ack every authenticated, fresh event — including ones we choose not to
    // deliver — so Linear does not retry a payload we deliberately ignored.
    return c.json({ ok: true }, 200);
  });

  return app;
}

async function handleEvent(
  deps: LinearWebhookDeps,
  action: string,
  entityType: string,
  data: unknown,
): Promise<void> {
  if (action !== "create" && action !== "update") return;

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (entityType === "Issue") {
    const issue = IssueEventData(data);
    if (issue instanceof type.errors) {
      log.debug("linear webhook: unparseable Issue data; dropping", {
        error: issue.summary,
      });
      return;
    }
    await route(deps, issue.assignee?.email ?? null, [
      buildIssueIntakeItem(issue, cutoff),
    ]);
    return;
  }

  if (entityType === "Comment") {
    const comment = CommentEventData(data);
    if (comment instanceof type.errors) {
      log.debug("linear webhook: unparseable Comment data; dropping", {
        error: comment.summary,
      });
      return;
    }
    const item = buildCommentIntakeItem(comment);
    if (item === null) {
      log.debug("linear webhook: comment has no issue reference; dropping");
      return;
    }
    await route(deps, comment.issue?.assignee?.email ?? null, [item]);
    return;
  }
}

/**
 * Route items to the member whose account email matches the issue assignee.
 * Never guesses: an event whose assignee email is absent or matches no known
 * member is dropped with a debug log. Honors the owner cascade + the member's
 * `inboxSource:linear` preference so a disabled source drops the event.
 */
async function route(
  deps: LinearWebhookDeps,
  assigneeEmail: string | null,
  items: ReturnType<typeof buildIssueIntakeItem>[],
): Promise<void> {
  const email = assigneeEmail?.trim().toLowerCase();
  if (!email) {
    log.debug("linear webhook: event has no assignee email; dropping");
    return;
  }

  const members = await deps.listMembers();
  const member = members.find((m) => m.email?.trim().toLowerCase() === email);
  if (!member) {
    log.debug("linear webhook: no member matches assignee email; dropping");
    return;
  }

  let ownerEnabled: boolean;
  try {
    ownerEnabled = await deps.isSourceEnabledForTenant(
      member.tenantId,
      SOURCE_KEY,
    );
  } catch {
    ownerEnabled = false;
  }
  if (!ownerEnabled) {
    log.debug("linear webhook: source owner-disabled for tenant; dropping");
    return;
  }

  const prefs = await readMemberPreferences(
    deps.db,
    member.tenantId,
    member.memberPrincipalId,
  );
  if (!resolveEnabledInboxSources(prefs).includes(SOURCE_KEY)) {
    log.debug("linear webhook: member has source disabled; dropping");
    return;
  }

  const target: InboxDeliveryTarget = member;
  const deliveryDeps: InboxDeliveryDeps = {
    db: deps.db,
    ...(deps.mailboxEventBus ? { mailboxEventBus: deps.mailboxEventBus } : {}),
    ...(deps.mailboxTriage ? { mailboxTriage: deps.mailboxTriage } : {}),
  };
  await deliverInboxItems(deliveryDeps, target, SOURCE_KEY, items);
}
