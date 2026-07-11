import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { getAncestorChain } from "@intx/db";
import {
  CreateScheduledTriggerBodySchema,
  ScheduledTriggerSchema,
  UpdateScheduledTriggerBodySchema,
} from "@workbench/shared";
import { resolveCallerMember } from "../lib/tenant-provisioning";
import { listRunnableWorkflowKinds } from "../lib/workflow-run-gate";
import {
  createOwnerSchedule,
  deleteOwnerSchedule,
  listOwnerSchedules,
  toApiSchedule,
  updateOwnerSchedule,
} from "../lib/scheduled-triggers";
import { requestBodySchema } from "../lib/openapi";
import type { HubDb } from "../db";

const ErrorResponse = type({ error: "string" });
const ScheduledTriggerList = ScheduledTriggerSchema.array();

// Payload keys the server owns. A trigger payload becomes the workflow's input
// verbatim, so client-supplied identity here would let a member address another
// member's mailbox — these keys are always derived from the caller's own
// member principal, never accepted from the request body.
const RESERVED_PAYLOAD_KEYS = new Set(["userAddress", "userRefId"]);

const MAX_PAYLOAD_BYTES = 8192;

export type ResolveUserIdentity = (
  memberPrincipalId: string,
) => Promise<{ userAddress: string; userRefId: string }>;

// Owner-scoped CRUD over the caller's automation triggers. Every read and write
// is scoped to the caller's own member principal, so a member can never see or
// mutate another member's schedule. Unblocks the scheduling UI (CL-2297).
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
      responses: {
        200: {
          description: "The caller's schedules (empty when none/no membership)",
          content: {
            "application/json": { schema: resolver(ScheduledTriggerList) },
          },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const member = await resolveCallerMember(db, userId);
      if (!member) return c.json([]);
      const rows = await listOwnerSchedules(
        db,
        member.tenantId,
        member.principalId,
      );
      return c.json(rows.map(toApiSchedule));
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
          description: "Caller has no provisioned membership yet",
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

      const chain = await getAncestorChain(db, member.tenantId);
      const kinds = await listRunnableWorkflowKinds(db, chain);
      if (!kinds.some((k) => k.kind === body.kind)) {
        return c.json({ error: `unknown workflow kind "${body.kind}"` }, 400);
      }

      const clientPayload = Object.fromEntries(
        Object.entries(body.payload ?? {}).filter(
          ([key]) => !RESERVED_PAYLOAD_KEYS.has(key),
        ),
      );
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

      const created = await createOwnerSchedule(db, {
        tenantId: member.tenantId,
        ownerPrincipalId: member.principalId,
        kind: body.kind,
        hourUtc: body.hourUtc,
        payload,
      });
      return c.json(toApiSchedule(created), 201);
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
      const id = c.req.param("id");
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
      const id = c.req.param("id");
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
