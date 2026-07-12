import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import {
  AvailableBriefSourcesResponseSchema,
  BRIEF_SOURCE_CATALOG,
  MemberPreferences,
  PreferenceSettingsResponseSchema,
  resolveAvailableBriefSources,
  resolvePreferenceSettings,
  validatePreferencePatch,
} from "@workbench/shared";
import { resolveCallerMember } from "../lib/tenant-provisioning";
import { resolveAvailableProviderNames } from "../lib/tenant-tools";
import {
  readMemberPreferences,
  mergeMemberPreferences,
} from "../lib/member-preferences";
import { ErrorResponse, requestBodySchema } from "../lib/openapi";
import type { HubDb } from "../db";

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
      const member = await resolveCallerMember(db, userId);
      if (!member) return c.json({});
      const prefs = await readMemberPreferences(
        db,
        member.tenantId,
        member.principalId,
      );
      return c.json(prefs);
    },
  );

  app.get(
    "/me/preferences/settings",
    describeRoute({
      tags: ["Me"],
      summary: "Get the registry-driven settings with the caller's values",
      description:
        "Every registered preference merged with the caller's stored value, falling back to the registry default. Drives the settings surface so the UI hardcodes no individual setting.",
      responses: {
        200: {
          description: "Resolved settings",
          content: {
            "application/json": {
              schema: resolver(PreferenceSettingsResponseSchema),
            },
          },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const member = await resolveCallerMember(db, userId);
      const stored = member
        ? await readMemberPreferences(db, member.tenantId, member.principalId)
        : {};
      return c.json({ settings: resolvePreferenceSettings(stored) });
    },
  );

  app.get(
    "/me/brief-sources",
    describeRoute({
      tags: ["Me"],
      summary: "Get the morning-brief sources the caller can toggle",
      description:
        "Every BRIEF_SOURCE_CATALOG entry whose provider has a credential configured for the caller's tenant, resolved against their stored enablement. A source with no configured credential is silently absent — never shown disabled.",
      responses: {
        200: {
          description: "Available brief sources",
          content: {
            "application/json": {
              schema: resolver(AvailableBriefSourcesResponseSchema),
            },
          },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const member = await resolveCallerMember(db, userId);
      if (!member) return c.json({ sources: [] });

      const wanted = new Set(BRIEF_SOURCE_CATALOG.map((s) => s.key));
      const [available, stored] = await Promise.all([
        resolveAvailableProviderNames(db, member.tenantId, wanted),
        readMemberPreferences(db, member.tenantId, member.principalId),
      ]);

      const sources = resolveAvailableBriefSources([...available], stored);
      return c.json({ sources });
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

      const registryError = validatePreferencePatch(patch);
      if (registryError) {
        return c.json({ error: registryError }, 400);
      }

      const member = await resolveCallerMember(db, userId);
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
