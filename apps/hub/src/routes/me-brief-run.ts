import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { resolveEnabledBriefSources } from "@workbench/shared";
import { resolveCallerMember } from "../lib/tenant-provisioning";
import { readMemberPreferences } from "../lib/member-preferences";
import { listOwnerSchedules } from "../lib/scheduled-triggers";
import { enrichHeartbeatTriggerPayload } from "../lib/heartbeat-trigger-payload";
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
// demand, outside its daily schedule. Mirrors the scheduler's fire-time
// enrichment (services/scheduler.ts startWorkflowRun call site in index.ts)
// so a manual run reads the same live brief-source preferences and the same
// createdAfter clamp a scheduled fire would — the only difference is the
// trigger path (`source: "manual"`), which the tenant-hour start budget in
// workflow-run-starter.ts does NOT exempt (only "scheduler" is exempt).
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
        404: {
          description:
            "Caller has no provisioned membership or no brief schedule yet",
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
        return c.json({ error: "No provisioned membership" }, 404);
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
      if (!heartbeat) {
        return c.json({ error: "No brief is set up yet" }, 404);
      }

      const prefs = await readMemberPreferences(
        deps.db,
        member.tenantId,
        member.principalId,
      );
      const nowMs = clock();
      const triggerPayload = enrichHeartbeatTriggerPayload(
        heartbeat.triggerPayload,
        deps.heartbeatKind,
        deps.heartbeatKind,
        resolveEnabledBriefSources(prefs),
        nowMs,
        heartbeat.lastFiredDayUtc,
        heartbeat.hourUtc,
      );

      const result = await deps.runStarter.startRun({
        kind: deps.heartbeatKind,
        tenantId: member.tenantId,
        input: triggerPayload,
        creatorPrincipalId: member.principalId,
        source: "manual",
      });

      if (!result.ok) {
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
