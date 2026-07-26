import { type } from "arktype";
import { Hono, type Context } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { getLogger } from "@intx/log";
import { createRateLimiter } from "../lib/rate-limit";
import { isUuid } from "../lib/uuid";
import {
  findWebhookTriggerById,
  markWebhookTriggerFired,
  secretMatchesHash,
} from "../lib/webhook-triggers";
import type { WorkflowRunStarter } from "../services/workflow-run-starter";
import type { WorkflowTriggerRow } from "../db/schema";
import type { HubDb } from "../db";

const log = getLogger(["routes", "webhook-trigger-fire"]);

const ErrorResponse = type({ error: "string" });
const AcceptedResponse = type({ accepted: "true" });

const MAX_BODY_BYTES = 32 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 6;

// Trusted client IP, mirroring the last-hop derivation in
// `../lib/rate-limit.ts` (not exported there, and this route is the only
// caller that needs to compose it with a second key component below, so it
// is kept local rather than widening that module's surface for one caller).
// `x-forwarded-for` is "client, proxy1, proxy2, …"; the entry appended by our
// own trusted ingress is the LAST one, so it is the only hop that is not
// client-spoofable. Returns `null` when there is no trusted forwarded hop.
function trustedClientIp(c: Context): string | null {
  const forwardedFor = c.req.header("x-forwarded-for");
  if (!forwardedFor) return null;
  const hops = forwardedFor.split(",");
  const last = hops[hops.length - 1];
  return last && last.trim().length > 0 ? last.trim() : null;
}

// Public webhook surface: no session, no sidecar token. The per-trigger
// secret is the only credential. Every rejection reason that could help an
// attacker enumerate valid trigger ids or secrets — unknown id, disabled
// trigger, malformed id, wrong secret — collapses to the same 404, so probing
// this endpoint learns nothing.
export function createWebhookTriggerFireRouter(deps: {
  db: HubDb;
  runStarter: WorkflowRunStarter;
}): Hono {
  const app = new Hono();

  // Keyed by client IP + trigger id, not trigger id alone: a bare
  // triggerId key lets anyone who learns a trigger URL 429 the legitimate
  // caller, and lets a flood of random trigger ids (which never reach the
  // secret check) fill `maxTrackedKeys` and force the limiter fail-open for
  // everyone. No trusted IP hop means no limiting for that request, same as
  // the default limiter behavior.
  const rateLimiter = createRateLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX,
    keyForRequest: (c) => {
      const ip = trustedClientIp(c);
      const triggerId = c.req.param("triggerId");
      if (ip === null || !triggerId) return null;
      return `${ip}:${triggerId}`;
    },
  });

  app.post(
    "/triggers/webhook/:triggerId",
    rateLimiter,
    describeRoute({
      tags: ["Triggers"],
      summary: "Fire a workflow run via a webhook trigger",
      responses: {
        202: {
          description: "Accepted; the run start is delivered asynchronously",
          content: {
            "application/json": { schema: resolver(AcceptedResponse) },
          },
        },
        400: {
          description: "Malformed JSON body",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description:
            "Unknown, disabled, or malformed trigger id, or an invalid secret (never distinguished)",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        413: {
          description: "Body exceeds the size ceiling",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        429: {
          description: "Too many requests for this trigger",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const triggerId = c.req.param("triggerId");
      const secret = c.req.header("x-trigger-secret");
      const notFound = () => c.json({ error: "not found" }, 404);

      // Param shape and trigger/secret validity are settled entirely from the
      // headers and a DB lookup, before a single byte of the body is read.
      // Without this ordering, an attacker with no valid secret can still
      // force the hub to buffer an arbitrarily large chunked-transfer body
      // (no Content-Length to reject early on) for every request.
      if (!isUuid(triggerId) || !secret) return notFound();

      const trigger = await findWebhookTriggerById(deps.db, triggerId);
      if (!trigger || !trigger.enabled) return notFound();
      if (!secretMatchesHash(secret, trigger.secretHash)) return notFound();

      const contentLength = c.req.header("content-length");
      if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
        return c.json({ error: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413);
      }

      const rawBody = await c.req.text();
      const bodyBytes = new TextEncoder().encode(rawBody).byteLength;
      if (bodyBytes > MAX_BODY_BYTES) {
        return c.json({ error: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413);
      }

      let payload: unknown = {};
      if (rawBody.length > 0) {
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return c.json({ error: "invalid JSON" }, 400);
        }
      }

      // Detached: the 202 means "accepted for processing", not "the run
      // started". Awaiting the full dispatch here would hold the connection
      // open for as long as run-start takes (session lookup, sidecar
      // delivery), which is neither what 202 promises nor bounded by
      // anything the caller controls.
      void dispatchRun(deps, trigger, payload);

      // Never leak deployment ids to an unauthenticated caller.
      return c.json({ accepted: true }, 202);
    },
  );

  return app;
}

// Fired-and-forgotten from the handler once the request is authenticated and
// parsed. `markWebhookTriggerFired` stamps before `startRun` rather than
// after it resolves ok: "fired" means an authenticated request reached
// dispatch, not that the downstream run succeeded — a workflow-side failure
// (e.g. no deployed workflow of that kind) should not make the trigger look
// like it never fired, since the caller already received a 202 and has no
// way to retry the exact same delivery.
async function dispatchRun(
  deps: { db: HubDb; runStarter: WorkflowRunStarter },
  trigger: WorkflowTriggerRow,
  payload: unknown,
): Promise<void> {
  try {
    await markWebhookTriggerFired(deps.db, trigger.id);
    const result = await deps.runStarter.startRun({
      kind: trigger.workflowKind,
      tenantId: trigger.tenantId,
      creatorPrincipalId: trigger.ownerMemberPrincipalId,
      input: { reason: "webhook", triggerId: trigger.id, payload },
      // Unattended, like the scheduler: the caller already has its 202 and
      // never sees a start failure, so pre-record failures must be recorded
      // and mailed rather than only logged (CL-4586). Budget behaviour is
      // unchanged — only `scheduler` is exempt.
      source: "webhook",
    });
    if (!result.ok) {
      log.error("webhook-triggered run start failed", {
        triggerId: trigger.id,
        kind: trigger.workflowKind,
        reason: result.reason,
        message: result.message,
      });
    }
  } catch (err) {
    log.error("webhook-triggered dispatch failed", {
      triggerId: trigger.id,
      kind: trigger.workflowKind,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
}
