import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { MemberPreferences } from "@workbench/shared";
import { lookupMember, getRootTenantId } from "../lib/tenant-provisioning";
import {
  readMemberPreferences,
  mergeMemberPreferences,
} from "../lib/member-preferences";
import { requestBodySchema } from "../lib/openapi";
import type { HubDb } from "../db";

const ErrorResponse = type({ error: "string" });

// Read/write the caller's own server-persisted UI preferences. Reads are also
// folded into GET /v1/me so the bootstrap needs no extra round-trip; this GET
// is the standalone fallback.
export function createMePreferencesRouter(
  db: HubDb,
): Hono<{ Variables: { userId: string } }> {
  const app = new Hono<{ Variables: { userId: string } }>();

  app.get(
    "/me/preferences",
    describeRoute({
      tags: ["Me"],
      summary: "Get the caller's persisted UI preferences",
      responses: {
        200: {
          description:
            "The caller preferences (empty object when none are set)",
          content: {
            "application/json": { schema: resolver(MemberPreferences) },
          },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const rootTenantId = await getRootTenantId(db);
      const member = rootTenantId
        ? await lookupMember(db, { tenantId: rootTenantId, userId })
        : null;
      if (!member) return c.json({});
      const prefs = await readMemberPreferences(
        db,
        member.tenantId,
        member.principalId,
      );
      return c.json(prefs);
    },
  );

  app.patch(
    "/me/preferences",
    describeRoute({
      tags: ["Me"],
      summary: "Merge a partial patch into the caller's UI preferences",
      description:
        "Each provided key overwrites that key in the stored preferences; omitted keys are left untouched. Returns the merged result.",
      requestBody: {
        content: {
          "application/json": { schema: requestBodySchema(MemberPreferences) },
        },
      },
      responses: {
        200: {
          description: "Merged preferences",
          content: {
            "application/json": { schema: resolver(MemberPreferences) },
          },
        },
        400: {
          description: "Invalid request body",
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
      const patch = MemberPreferences(raw);
      if (patch instanceof type.errors) {
        return c.json({ error: patch.summary }, 400);
      }

      const rootTenantId = await getRootTenantId(db);
      const member = rootTenantId
        ? await lookupMember(db, { tenantId: rootTenantId, userId })
        : null;
      if (!member) {
        return c.json({ error: "No provisioned membership" }, 409);
      }

      const merged = await mergeMemberPreferences(
        db,
        member.tenantId,
        member.principalId,
        patch,
      );
      return c.json(merged);
    },
  );

  return app;
}
