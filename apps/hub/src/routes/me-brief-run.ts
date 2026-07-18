import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { resolveCallerMember } from "../lib/tenant-provisioning";
import { listOwnerSchedules } from "../lib/scheduled-triggers";
import { slidingWindowLimiter } from "../lib/sliding-window";
import { ErrorResponse } from "../lib/openapi";
import type { HubDb } from "../db";
import type { WorkflowRunStarter } from "../services/workflow-run-starter";

// One manual brief per member per rolling window — a member mashing the
// button should get one honest run, not a pile of duplicate briefs.
const BRIEF_RUN_MAX_PER_WINDOW = 1;
const BRIEF_RUN_WINDOW_MS = 10 * 60 * 1000;

export const BriefRunResponse = type({
  status: "'started'",
  deploymentId: "string",
});
export type BriefRunResponse = typeof BriefRunResponse.infer;

// POST /me/brief-run: lets a member fire their own heartbeat brief on
// demand, outside its daily schedule. Trigger-payload enrichment (current
// brief-source preferences, mail identity, the manual-refresh 7-day
// `createdAfter` lookback) is NOT done here — it happens inside
// `runStarter.startRun` via the shared trigger-payload-enrichment registry,
// the one application point every start door (webhook, scheduler, this
// route, the generic /workflow-exec route, the workflow_start hub tool)
// funnels through. This route's only job is resolving the caller and
// building the base payload; `startRun`'s "manual" source defaults the
// registry's lookback to the same 7-day `manual-refresh` window this route
// used to compute itself.
//
// The `startRun` call is wrapped in a try/catch: the registry resolves the
// member's mail identity as part of enrichment, and a failure there (e.g. a
// transient identity lookup error) must still refund the member's rate-limit
// slot and return the same crafted 502 this route already returns for a
// structured `{ ok: false }` failure — not an unhandled 500 that both loses
// the slot and leaks internals.
export function createMeBriefRunRouter(deps: {
  db: HubDb;
  runStarter: WorkflowRunStarter;
  heartbeatKind: string;
  now?: () => number;
}): Hono<{ Variables: { userId: string } }> {
  const app = new Hono<{ Variables: { userId: string } }>();
  const clock = deps.now ?? Date.now;
  const briefRunLimiter = slidingWindowLimiter(
    BRIEF_RUN_MAX_PER_WINDOW,
    BRIEF_RUN_WINDOW_MS,
    clock,
  );

  app.post(
    "/me/brief-run",
    describeRoute({
      tags: ["Me"],
      summary: "Trigger the caller's own morning brief right now",
      description:
        "Starts one heartbeat-brief run for the caller immediately, using their current brief-source preferences, instead of waiting for the daily schedule. Rate-limited to one manual run per member per 10 minutes.",
      responses: {
        200: {
          description: "Brief run started",
          content: {
            "application/json": { schema: resolver(BriefRunResponse) },
          },
        },
        403: {
          description: "Caller has no provisioned membership",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        429: {
          description:
            "Caller already triggered a manual brief within the last 10 minutes",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        502: {
          description: "The brief could not be started",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const member = await resolveCallerMember(deps.db, userId);
      if (!member) {
        return c.json({ error: "No provisioned membership" }, 403);
      }

      if (!briefRunLimiter.tryAcquire(member.principalId)) {
        return c.json(
          { error: "You just ran a brief — try again in a few minutes" },
          429,
        );
      }

      const schedules = await listOwnerSchedules(
        deps.db,
        member.tenantId,
        member.principalId,
      );
      const heartbeat = schedules.items.find(
        (row) => row.workflowKind === deps.heartbeatKind,
      );
      // Schedule seeding is boot-only and env-gated, so a member can lack a
      // row through no fault of their own (fresh member, scheduler disabled).
      // A manual run does not need the row — build the same base payload ad
      // hoc; `startRun`'s registry enrichment fills in the rest.
      const basePayload: Record<string, unknown> = {
        ...(heartbeat ? heartbeat.triggerPayload : {}),
        reason: "manual-brief",
      };

      let result: Awaited<ReturnType<WorkflowRunStarter["startRun"]>>;
      try {
        result = await deps.runStarter.startRun({
          kind: deps.heartbeatKind,
          tenantId: member.tenantId,
          input: basePayload,
          creatorPrincipalId: member.principalId,
          source: "manual",
        });
      } catch {
        // A run that never started — including one whose trigger-payload
        // enrichment failed to resolve the caller's identity — must not cost
        // the member their one manual slot for the window.
        briefRunLimiter.refund(member.principalId);
        return c.json({ error: "The brief could not be started" }, 502);
      }

      if (!result.ok) {
        // A run that never started should not cost the member their one
        // manual slot for the window.
        briefRunLimiter.refund(member.principalId);
        if (result.reason === "not_found") {
          return c.json({ error: "No brief is set up yet" }, 404);
        }
        if (result.reason === "rate_limited") {
          return c.json(
            { error: "You just ran a brief — try again in a few minutes" },
            429,
          );
        }
        return c.json({ error: "The brief could not be started" }, 502);
      }

      return c.json({ status: "started", deploymentId: result.deploymentId });
    },
  );

  return app;
}
