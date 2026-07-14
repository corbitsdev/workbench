import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import {
  CreateScheduledTriggerBodySchema,
  ScheduledTriggerListResponseSchema,
  ScheduledTriggerSchema,
  UpdateScheduledTriggerBodySchema,
} from "@workbench/shared";
import { resolveCallerMember } from "../lib/tenant-provisioning";
import { isRunnableKind } from "../lib/workflow-run-gate";
import { loadWorkflowGateInfos } from "../lib/workflow-catalog";
import { isKindStructurallyAttachable } from "../lib/workflow-gate-info";
import { INTAKE_SIGNAL_NAME } from "../lib/scheduled-intake";
import { validateResumePayload } from "../workflow-executor/resume-payload-registry";
import { UuidParam } from "../lib/uuid";
import {
  createOwnerSchedule,
  deleteOwnerSchedule,
  listOwnerSchedules,
  toApiSchedule,
  updateOwnerSchedule,
} from "../lib/scheduled-triggers";
import { ErrorResponse, requestBodySchema } from "../lib/openapi";
import { clampLimit, decodeCursor, MAX_PAGE_LIMIT } from "../lib/keyset";
import type { HubDb } from "../db";

const DEFAULT_SCHEDULES_PAGE_LIMIT = 50;

// Payload keys the server owns. A trigger payload becomes the workflow's input
// verbatim, so client-supplied identity here would let a member address another
// member's mailbox — these keys are always derived from the caller's own
// member principal, never accepted from the request body.
const RESERVED_PAYLOAD_KEYS = new Set(["userAddress", "userRefId"]);

const MAX_PAYLOAD_BYTES = 8192;

const UNIQUE_VIOLATION_CODE = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION_CODE
  );
}

export type ResolveUserIdentity = (
  memberPrincipalId: string,
) => Promise<{ userAddress: string; userRefId: string }>;

// Owner-scoped CRUD over the caller's automation triggers. Every read and write
// is scoped to the caller's own member principal, so a member can never see or
// mutate another member's schedule. Unblocks the scheduling UI.
export function createMeSchedulesRouter(
  db: HubDb,
  resolveUserIdentity: ResolveUserIdentity,
): Hono<{ Variables: { userId: string } }> {
  const app = new Hono<{ Variables: { userId: string } }>();

  app.get(
    "/me/schedules",
    describeRoute({
      tags: ["Me"],
      summary: "List the caller's automation schedules",
      parameters: [
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: MAX_PAGE_LIMIT },
          description: `Maximum schedules to return (default ${DEFAULT_SCHEDULES_PAGE_LIMIT}, clamped to ${MAX_PAGE_LIMIT})`,
        },
        {
          name: "cursor",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Opaque keyset cursor from a previous page's nextCursor; omit for the first page",
        },
      ],
      responses: {
        200: {
          description:
            "One page of the caller's schedules (empty when none/no membership)",
          content: {
            "application/json": {
              schema: resolver(ScheduledTriggerListResponseSchema),
            },
          },
        },
        400: {
          description: "Invalid limit or cursor",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const limit = clampLimit(c.req.query("limit"), {
        default: DEFAULT_SCHEDULES_PAGE_LIMIT,
      });
      if (limit === null) {
        return c.json({ error: "limit must be a positive integer" }, 400);
      }
      const rawCursor = c.req.query("cursor");
      const cursor =
        rawCursor === undefined ? undefined : decodeCursor(rawCursor);
      if (rawCursor !== undefined && cursor === null) {
        return c.json({ error: "malformed cursor" }, 400);
      }
      const member = await resolveCallerMember(db, userId);
      if (!member) return c.json({ items: [] });
      const page = await listOwnerSchedules(
        db,
        member.tenantId,
        member.principalId,
        { limit, ...(cursor ? { cursor } : {}) },
      );
      return c.json({
        items: page.items.map(toApiSchedule),
        ...(page.nextCursor !== undefined
          ? { nextCursor: page.nextCursor }
          : {}),
      });
    },
  );

  app.post(
    "/me/schedules",
    describeRoute({
      tags: ["Me"],
      summary: "Create an automation schedule for the caller",
      requestBody: {
        content: {
          "application/json": {
            schema: requestBodySchema(CreateScheduledTriggerBodySchema),
          },
        },
      },
      responses: {
        201: {
          description: "The created schedule",
          content: {
            "application/json": { schema: resolver(ScheduledTriggerSchema) },
          },
        },
        400: {
          description: "Invalid body or unknown workflow kind",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        409: {
          description:
            "Caller has no provisioned membership yet, or already has a schedule for this workflow kind",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const raw = await c.req.json().catch(() => null);
      const body = CreateScheduledTriggerBodySchema(raw);
      if (body instanceof type.errors) {
        return c.json({ error: body.summary }, 400);
      }

      const member = await resolveCallerMember(db, userId);
      if (!member) {
        return c.json({ error: "No provisioned membership" }, 409);
      }

      if (!(await isRunnableKind(db, member.tenantId, body.kind))) {
        return c.json({ error: `unknown workflow kind "${body.kind}"` }, 400);
      }

      // Attach gate (CL-3508/CL-3509): a schedule fires unattended, so only kinds
      // that can run to completion without a human belong here — either fully
      // unattended (no gates), or their ONLY human gate is `intake`, which the
      // scheduler pre-fills from the stored payload and auto-delivers. A kind with
      // any other human gate would park forever, so it is rejected. A
      // requiresIntake kind additionally must carry a valid stored intake payload.
      const gateInfos = await loadWorkflowGateInfos();
      const gateInfo = gateInfos.get(body.kind);
      if (gateInfo === undefined || !isKindStructurallyAttachable(gateInfo)) {
        return c.json(
          {
            error: `workflow "${body.kind}" cannot be scheduled: it needs input this schedule can't supply`,
          },
          400,
        );
      }

      const clientPayload = Object.fromEntries(
        Object.entries(body.payload ?? {}).filter(
          ([key]) => !RESERVED_PAYLOAD_KEYS.has(key),
        ),
      );

      if (gateInfo.requiresIntake) {
        const check = validateResumePayload(
          body.kind,
          INTAKE_SIGNAL_NAME,
          clientPayload,
        );
        if (!check.ok) {
          return c.json(
            { error: `invalid intake for "${body.kind}": ${check.error}` },
            400,
          );
        }
      }
      const identity = await resolveUserIdentity(member.principalId);
      const payload = {
        ...clientPayload,
        userAddress: identity.userAddress,
        userRefId: identity.userRefId,
      };
      const payloadBytes = new TextEncoder().encode(
        JSON.stringify(payload),
      ).byteLength;
      if (payloadBytes > MAX_PAYLOAD_BYTES) {
        return c.json(
          { error: `payload exceeds ${MAX_PAYLOAD_BYTES} bytes` },
          400,
        );
      }

      try {
        const created = await createOwnerSchedule(db, {
          tenantId: member.tenantId,
          ownerPrincipalId: member.principalId,
          kind: body.kind,
          hourUtc: body.hourUtc,
          payload,
        });
        return c.json(toApiSchedule(created), 201);
      } catch (err) {
        if (isUniqueViolation(err)) {
          return c.json(
            { error: "You already have a schedule for this workflow." },
            409,
          );
        }
        throw err;
      }
    },
  );

  app.patch(
    "/me/schedules/:id",
    describeRoute({
      tags: ["Me"],
      summary: "Update the caller's schedule (enablement and/or fire hour)",
      requestBody: {
        content: {
          "application/json": {
            schema: requestBodySchema(UpdateScheduledTriggerBodySchema),
          },
        },
      },
      responses: {
        200: {
          description: "The updated schedule",
          content: {
            "application/json": { schema: resolver(ScheduledTriggerSchema) },
          },
        },
        400: {
          description: "Invalid body or empty patch",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "No such schedule owned by the caller",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        409: {
          description: "Caller has no provisioned membership yet",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const id = UuidParam(c.req.param("id"));
      if (id instanceof type.errors) {
        return c.json({ error: "Schedule id must be a UUID" }, 400);
      }
      const raw = await c.req.json().catch(() => null);
      const body = UpdateScheduledTriggerBodySchema(raw);
      if (body instanceof type.errors) {
        return c.json({ error: body.summary }, 400);
      }
      if (body.enabled === undefined && body.hourUtc === undefined) {
        return c.json({ error: "no fields to update" }, 400);
      }

      const member = await resolveCallerMember(db, userId);
      if (!member) {
        return c.json({ error: "No provisioned membership" }, 409);
      }

      const updated = await updateOwnerSchedule(db, {
        tenantId: member.tenantId,
        ownerPrincipalId: member.principalId,
        id,
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.hourUtc !== undefined ? { hourUtc: body.hourUtc } : {}),
      });
      if (!updated) return c.json({ error: "schedule not found" }, 404);
      return c.json(toApiSchedule(updated));
    },
  );

  app.delete(
    "/me/schedules/:id",
    describeRoute({
      tags: ["Me"],
      summary: "Delete the caller's schedule",
      responses: {
        204: { description: "Deleted" },
        400: {
          description: "Malformed schedule id",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "No such schedule owned by the caller",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        409: {
          description: "Caller has no provisioned membership yet",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const id = UuidParam(c.req.param("id"));
      if (id instanceof type.errors) {
        return c.json({ error: "Schedule id must be a UUID" }, 400);
      }
      const member = await resolveCallerMember(db, userId);
      if (!member) {
        return c.json({ error: "No provisioned membership" }, 409);
      }
      const deleted = await deleteOwnerSchedule(db, {
        tenantId: member.tenantId,
        ownerPrincipalId: member.principalId,
        id,
      });
      if (!deleted) return c.json({ error: "schedule not found" }, 404);
      return c.body(null, 204);
    },
  );

  return app;
}
