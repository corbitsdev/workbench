import { createHmac, timingSafeEqual } from "node:crypto";
import { type } from "arktype";
import { Hono } from "hono";
import { getLogger } from "@intx/log";
import { resolveEnabledInboxSources } from "@workbench/shared";
import type { AttioToolsConfig } from "@workbench/tools-attio";
import { createAttioTools } from "@workbench/tools-attio";
import type { AgentTool } from "@intx/agent";
import type { HubDb } from "../db";
import { readMemberPreferences } from "../lib/member-preferences";
import { resolveMemberOrTenantToolCredential } from "../lib/member-tool-credential";
import type { InboxIntakeMember } from "../services/inbox-source-registry";
import {
  AttioRawTaskSchema,
  syncOneTask,
  type AttioRawTask,
} from "../services/inbox-sources/attio-task-sync";

const log = getLogger(["routes", "webhooks-attio"]);

const SOURCE_KEY = "attio";
const MAX_BODY_BYTES = 256 * 1024;
// At-least-once redelivery within this window collapses to a no-op via the
// in-memory Idempotency-Key cache below. This is a latency/log-noise
// optimization only — the true correctness backstop is `syncOneTask`'s
// upsert-by-`sourceRef`, which is idempotent by construction (a redelivered
// event with no actual state change is already a no-op there even after this
// cache entry expires or the process restarts).
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
// Bounds the cache like its Slack sibling (`slack-event-dedupe.ts`): a size
// cap plus oldest-first eviction on overflow, on top of the TTL sweep, so an
// unbounded flood of distinct Idempotency-Keys cannot grow the map forever.
const MAX_IDEMPOTENCY_KEYS = 5000;

export interface AttioIdempotencyCache {
  /** Returns true the FIRST time a key is seen within its TTL (i.e. "process
   * it"), false on every subsequent call with the same key. */
  remember(key: string, now: number): boolean;
}

/** Overridable for tests via `AttioWebhookDeps.idempotencyCache` so the size
 * bound can be exercised without sending `MAX_IDEMPOTENCY_KEYS` requests. */
export function createAttioIdempotencyCache(
  maxEntries: number = MAX_IDEMPOTENCY_KEYS,
): AttioIdempotencyCache {
  const seen = new Map<string, number>();
  return {
    remember(key: string, now: number): boolean {
      for (const [k, expiresAt] of seen) {
        if (expiresAt <= now) seen.delete(k);
      }
      if (seen.has(key)) return false;
      if (seen.size >= maxEntries) {
        const oldestKey = seen.keys().next().value;
        if (oldestKey !== undefined) seen.delete(oldestKey);
      }
      seen.set(key, now + IDEMPOTENCY_TTL_MS);
      return true;
    },
  };
}

/**
 * Attio webhook event envelope. Attio batches one or more events per
 * delivery under `events`; each event carries only the changed task's id —
 * the full task state must be re-fetched via `attio_get_task` (CL-3586).
 */
const AttioWebhookEnvelope = type({
  webhook_id: "string",
  events: type({
    event_type: "string",
    id: { task_id: "string" },
  }).array(),
});

export interface AttioWebhookDeps {
  db: HubDb;
  /** The HMAC-SHA256 signing secret configured for this Attio webhook. */
  secret: string;
  /** Enumerate the members an event can be routed to. */
  listMembers: () => Promise<InboxIntakeMember[]>;
  /** Owner cascade (CL-3584): whether the source is enabled for the tenant. */
  isSourceEnabledForTenant: (
    tenantId: string,
    sourceKey: string,
  ) => Promise<boolean>;
  /** Injection seam for tests; defaults to real clock. */
  now?: () => number;
  /** Injection seam for tests; defaults to a fresh, module-scoped cache
   * bounded at `MAX_IDEMPOTENCY_KEYS`. */
  idempotencyCache?: AttioIdempotencyCache;
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
 * Public Attio webhook receiver (CL-3586). Mounted only when
 * `ATTIO_WEBHOOK_SECRET` is set. Verifies the `Attio-Signature` HMAC (legacy
 * `X-Attio-Signature` also accepted) over the RAW body BEFORE parsing, dedupes
 * on `Idempotency-Key`, then for each `task.created`/`task.updated` event
 * re-fetches the full task via `attio_get_task` (webhooks carry only ids) and
 * runs it through the SAME `syncOneTask` upsert the poller uses — so a
 * webhook delivery and a subsequent poll of the same task collapse to one
 * Workbench task row via the `attio:task:<id>` sourceRef.
 *
 * Attio webhooks are workspace-level, not member-scoped like the poller,
 * so routing re-derives which member an event belongs to from the task's
 * `assignees` against each candidate member's `attioMemberId` preference
 * (the same self-assignment gating `attio-task-sync.ts` applies) — an event
 * with no attributable member is dropped with a debug log.
 *
 * Manual setup (Attio → workspace settings → Webhooks): create a webhook
 * subscription for `task.created` and `task.updated` at
 * `https://<hub-host>/webhooks/attio`, and copy the signing secret into
 * `ATTIO_WEBHOOK_SECRET`.
 */
export function createAttioWebhookRouter(deps: AttioWebhookDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? Date.now;
  const idempotencyCache =
    deps.idempotencyCache ?? createAttioIdempotencyCache();

  app.post("/webhooks/attio", async (c) => {
    const signature =
      c.req.header("Attio-Signature") ?? c.req.header("X-Attio-Signature");
    if (!signature) {
      log.warn("attio webhook: missing signature header; rejecting");
      return c.json({ error: "missing signature" }, 401);
    }

    const contentLength = c.req.header("content-length");
    if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
      return c.json({ error: "payload too large" }, 413);
    }

    const rawBody = await c.req.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return c.json({ error: "payload too large" }, 413);
    }

    const expected = createHmac("sha256", deps.secret)
      .update(rawBody)
      .digest("hex");
    if (!signatureMatches(expected, signature)) {
      log.warn("attio webhook: signature mismatch; rejecting");
      return c.json({ error: "invalid signature" }, 401);
    }

    const idempotencyKey = c.req.header("Idempotency-Key");
    if (idempotencyKey && !idempotencyCache.remember(idempotencyKey, now())) {
      log.debug(
        "attio webhook: duplicate delivery; acking without reprocessing",
        {
          idempotencyKey,
        },
      );
      return c.json({ ok: true }, 200);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }

    const envelope = AttioWebhookEnvelope(payload);
    if (envelope instanceof type.errors) {
      return c.json({ error: "unrecognized payload" }, 400);
    }

    for (const event of envelope.events) {
      if (
        event.event_type !== "task.created" &&
        event.event_type !== "task.updated"
      ) {
        continue;
      }
      try {
        await handleTaskEvent(deps, event.id.task_id);
      } catch (err) {
        log.error("attio webhook: failed to process task event", {
          taskId: event.id.task_id,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    // Ack every authenticated, parseable delivery — including ones we chose
    // not to act on (unattributable member, disabled source) — so Attio does
    // not retry a payload we deliberately dropped.
    return c.json({ ok: true }, 200);
  });

  return app;
}

function toolHandler(config: AttioToolsConfig, name: string) {
  const tools: AgentTool[] = createAttioTools(config);
  const tool = tools.find((entry) => entry.definition.name === name);
  if (tool === undefined) {
    throw new Error(`webhooks-attio: could not resolve tool ${name}`);
  }
  if (tool.kind !== "string") {
    throw new Error(`webhooks-attio: expected a string-handler tool ${name}`);
  }
  return tool.handler;
}

async function fetchFullTask(
  config: AttioToolsConfig,
  taskId: string,
  signal: AbortSignal,
): Promise<AttioRawTask | null> {
  const handler = toolHandler(config, "attio_get_task");
  const raw = await handler({ taskId, hydrateLinkedRecords: false }, signal);
  const parsed: unknown = JSON.parse(raw);
  const taskField =
    parsed !== null && typeof parsed === "object" && "task" in parsed
      ? (parsed as { task: unknown }).task
      : undefined;
  const validated = AttioRawTaskSchema(taskField);
  if (validated instanceof type.errors) return null;
  return validated;
}

function attioToolsConfig(credential: {
  apiKey: string;
  baseURL: string;
}): AttioToolsConfig {
  const config: AttioToolsConfig = { apiKey: credential.apiKey };
  if (credential.baseURL.length > 0) config.baseUrl = credential.baseURL;
  return config;
}

/**
 * Resolve which known member a task's assignees attribute to, by matching
 * each candidate member's stored `attioMemberId` preference. Mirrors the
 * poller's `isAssignedToSelf` gating, but from the opposite direction (many
 * candidate members, one task) since a webhook has no polling member of its
 * own to scope to. Returns `null` when no candidate matches — the event is
 * then dropped, never guessed at.
 */
async function resolveAttributedMember(
  deps: AttioWebhookDeps,
  members: readonly InboxIntakeMember[],
  assigneeIds: ReadonlySet<string>,
): Promise<InboxIntakeMember | null> {
  if (assigneeIds.size === 0) return null;
  for (const member of members) {
    const prefs = await readMemberPreferences(
      deps.db,
      member.tenantId,
      member.memberPrincipalId,
    );
    if (prefs.attioMemberId && assigneeIds.has(prefs.attioMemberId)) {
      return member;
    }
  }
  return null;
}

async function handleTaskEvent(
  deps: AttioWebhookDeps,
  taskId: string,
): Promise<void> {
  const members = await deps.listMembers();
  if (members.length === 0) {
    log.debug("attio webhook: no members to attribute event to; dropping");
    return;
  }

  // The task must be re-fetched to know its assignees before a member can be
  // attributed — fetched with the FIRST candidate's credential, since Attio
  // tenant/member credentials all read the same workspace-level API.
  const firstCandidate = members[0];
  if (firstCandidate === undefined) return;
  const probeCredential = await resolveMemberOrTenantToolCredential(
    deps.db,
    firstCandidate.tenantId,
    firstCandidate.memberPrincipalId,
    SOURCE_KEY,
  );
  if (!probeCredential) {
    log.info("attio webhook: no usable Attio credential; dropping event", {
      taskId,
    });
    return;
  }

  const controller = new AbortController();
  const attioTask = await fetchFullTask(
    attioToolsConfig(probeCredential),
    taskId,
    controller.signal,
  );
  if (attioTask === null) {
    log.debug("attio webhook: unparseable or missing task; dropping", {
      taskId,
    });
    return;
  }

  const assigneeIds = new Set(
    (attioTask.assignees ?? [])
      .map((a) => a.referenced_actor_id)
      .filter((id): id is string => id !== undefined),
  );
  const member = await resolveAttributedMember(deps, members, assigneeIds);
  if (member === null) {
    log.debug("attio webhook: no member matches task assignees; dropping", {
      taskId,
    });
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
    log.debug("attio webhook: source owner-disabled for tenant; dropping", {
      taskId,
    });
    return;
  }

  const prefs = await readMemberPreferences(
    deps.db,
    member.tenantId,
    member.memberPrincipalId,
  );
  if (!resolveEnabledInboxSources(prefs).includes(SOURCE_KEY)) {
    log.debug("attio webhook: member has source disabled; dropping", {
      taskId,
    });
    return;
  }

  await syncOneTask(
    deps.db,
    member,
    attioTask,
    new Date(0),
    prefs.attioMemberId,
  );
}
