import { type } from "arktype";
import { Hono } from "hono";
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
import type { HubDb } from "../db";

const log = getLogger(["routes", "webhook-trigger-fire"]);

const ErrorResponse = type({ error: "string" });
const AcceptedResponse = type({ accepted: "true" });

const MAX_BODY_BYTES = 32 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 6;

// Public webhook surface (CL-3300): no session, no sidecar token. The
// per-trigger secret is the only credential. Every rejection reason that
// could help an attacker enumerate valid trigger ids or secrets — unknown id,
// disabled trigger, malformed id, wrong secret — collapses to the same 404,
// so probing this endpoint learns nothing.
export function createWebhookTriggerFireRouter(deps: {
  db: HubDb;
  runStarter: WorkflowRunStarter;
}): Hono {
  const app = new Hono();

  const rateLimiter = createRateLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX,
    keyForRequest: (c) => c.req.param("triggerId") ?? null,
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

      if (!isUuid(triggerId) || !secret) return notFound();

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

      const trigger = await findWebhookTriggerById(deps.db, triggerId);
      if (!trigger || !trigger.enabled) return notFound();
      if (!secretMatchesHash(secret, trigger.secretHash)) return notFound();

      await markWebhookTriggerFired(deps.db, trigger.id);

      const result = await deps.runStarter.startRun({
        kind: trigger.workflowKind,
        tenantId: trigger.tenantId,
        creatorPrincipalId: trigger.ownerMemberPrincipalId,
        input: { reason: "webhook", triggerId: trigger.id, payload },
      });
      if (!result.ok) {
        log.error("webhook-triggered run start failed", {
          triggerId: trigger.id,
          kind: trigger.workflowKind,
          reason: result.reason,
          message: result.message,
        });
      }

      // Never leak deployment ids to an unauthenticated caller.
      return c.json({ accepted: true }, 202);
    },
  );

  return app;
}
