import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import {
  HeartbeatRunTriggerPayloadSchema,
  resolveEnabledBriefSources,
} from "@workbench/shared";
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
// demand, outside its daily schedule. Reads the same live brief-source
// preferences as the scheduler (`resolveEnabledBriefSources`), but uses a
// full 7-day `createdAfter` lookback (`manual-refresh`) instead of the
// incremental since-last-scheduled-fire window — so an on-demand run is a
// refresh, not "delta since this morning." Trigger path is `source: "manual"`;
// the tenant-hour start budget in workflow-run-starter.ts does NOT exempt
// manual (only "scheduler" is exempt).
export function createMeBriefRunRouter(deps: {
  db: HubDb;
  runStarter: WorkflowRunStarter;
  heartbeatKind: string;
  resolveUserIdentity: (
    memberPrincipalId: string,
  ) => Promise<{ userAddress: string; userRefId: string }>;
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
      // A manual run does not need the row — build the same payload ad hoc.
      let basePayload: Record<string, unknown>;
      let lastFiredDayUtc: number | null;
      let hourUtc: number;
      if (heartbeat) {
        basePayload = heartbeat.triggerPayload;
        lastFiredDayUtc = heartbeat.lastFiredDayUtc;
        hourUtc = heartbeat.hourUtc;
      } else {
        basePayload = { reason: "manual-brief" };
        lastFiredDayUtc = null;
        hourUtc = 0;
      }

      let identity: { userAddress: string; userRefId: string };
      try {
        identity = await deps.resolveUserIdentity(member.principalId);
      } catch {
        briefRunLimiter.refund(member.principalId);
        return c.json({ error: "The brief could not be started" }, 502);
      }

      const prefs = await readMemberPreferences(
        deps.db,
        member.tenantId,
        member.principalId,
      );
      const nowMs = clock();
      const triggerPayload = enrichHeartbeatTriggerPayload(
        { ...basePayload, reason: "manual-brief" },
        deps.heartbeatKind,
        deps.heartbeatKind,
        resolveEnabledBriefSources(prefs),
        nowMs,
        lastFiredDayUtc,
        hourUtc,
        "manual-refresh",
        identity,
      );
      const validated = HeartbeatRunTriggerPayloadSchema(triggerPayload);
      if (validated instanceof type.errors) {
        briefRunLimiter.refund(member.principalId);
        return c.json({ error: "The brief could not be started" }, 502);
      }

      const result = await deps.runStarter.startRun({
        kind: deps.heartbeatKind,
        tenantId: member.tenantId,
        input: validated,
        creatorPrincipalId: member.principalId,
        source: "manual",
      });

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
