import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import type { GrantStore } from "@intx/authz";
import { getLogger } from "@intx/log";
import {
  AvailableBriefSourcesResponseSchema,
  AvailableInboxSourcesResponseSchema,
  BRIEF_SOURCE_CATALOG,
  INBOX_SOURCE_CATALOG,
  inboxCapabilityPreferenceKey,
  MemberPreferences,
  OAUTH_PROVIDER_CATALOG,
  PreferenceSettingsResponseSchema,
  resolveAvailableBriefSources,
  resolveAvailableInboxSources,
  resolvePreferenceSettings,
  validatePreferencePatch,
} from "@workbench/shared";
import { resolveCallerMember } from "../lib/tenant-provisioning";
import {
  isCapabilityAllowedForPrincipal,
  setPrincipalCapabilityGrant,
} from "../lib/capability-grants";
import { resolveAvailableProviderNames } from "../lib/tenant-tools";
import { resolveMemberOrTenantToolCredential } from "../lib/member-tool-credential";
import { isInboxSourceEnabledFromGrants } from "../lib/workspace-inbox-source-gate";
import { loadMemberRoleGrantsForTenantChain } from "../lib/workflow-run-gate";
import {
  readMemberPreferences,
  mergeMemberPreferences,
} from "../lib/member-preferences";
import { ErrorResponse, requestBodySchema } from "../lib/openapi";
import type { HubDb } from "../db";

const log = getLogger(["api", "me-preferences"]);

/**
 * Inbox-source availability for THIS member (CL-3577 greybeard finding): a
 * source must appear in the member's own list exactly when delivery would
 * actually use it, so it is resolved through the same
 * `resolveMemberOrTenantToolCredential` the delivery path (triage/intake)
 * calls — preferring the member's own connected OAuth token, falling back to
 * the tenant-owned key. `resolveAvailableProviderNames` (tenant-only) is
 * intentionally NOT used here: a member with a personal OAuth connection but
 * no tenant key must see the source, which the tenant-only check would hide.
 * One resolution per wanted provider for the single requesting member — a
 * small, fixed set, so this stays cheap despite not being batched.
 */
async function resolveMemberAvailableProviderNames(
  db: HubDb,
  tenantId: string,
  memberPrincipalId: string,
  wanted: Set<string>,
): Promise<Set<string>> {
  const available = new Set<string>();
  await Promise.all(
    [...wanted].map(async (providerName) => {
      try {
        const resolved = await resolveMemberOrTenantToolCredential(
          db,
          tenantId,
          memberPrincipalId,
          providerName,
        );
        if (resolved !== null) available.add(providerName);
      } catch (error) {
        log.warn("member credential resolution failed; hiding inbox source", {
          providerName,
          tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
  return available;
}

// Read/write the caller's own server-persisted UI preferences. Reads are also
// folded into GET /v1/me so the bootstrap needs no extra round-trip; this GET
// is the standalone fallback.
export function createMePreferencesRouter(
  db: HubDb,
  grantStore: GrantStore,
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

  app.get(
    "/me/inbox-sources",
    describeRoute({
      tags: ["Me"],
      summary: "Get the inbox sources the caller can toggle",
      description:
        "Every INBOX_SOURCE_CATALOG entry the caller can actually receive deliveries from — resolved via the member's own connected credential or, failing that, the tenant-owned key (the same precedence delivery uses) — resolved against their stored enablement, independent of the caller's brief-source toggles. A source neither the member nor the tenant has a credential for is silently absent — never shown disabled.",
      responses: {
        200: {
          description: "Available inbox sources",
          content: {
            "application/json": {
              schema: resolver(AvailableInboxSourcesResponseSchema),
            },
          },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const member = await resolveCallerMember(db, userId);
      if (!member) return c.json({ sources: [] });

      const wanted = new Set(INBOX_SOURCE_CATALOG.map((s) => s.key));
      const [available, stored, grants] = await Promise.all([
        resolveMemberAvailableProviderNames(
          db,
          member.tenantId,
          member.principalId,
          wanted,
        ),
        readMemberPreferences(db, member.tenantId, member.principalId),
        loadMemberRoleGrantsForTenantChain(db, [member.tenantId]),
      ]);

      // Owner ceiling (CL-3584): only surface sources the owner has enabled for
      // the tenant, intersected with those that have a configured credential.
      // An owner-disabled source is hidden entirely (never greyed out), so the
      // member UI has no confusion. The member's stored preference is untouched
      // and re-appears when the owner re-enables the source.
      const ownerEnabled = new Set<string>();
      for (const key of available) {
        if (await isInboxSourceEnabledFromGrants(grants, key)) {
          ownerEnabled.add(key);
        }
      }

      const sources = resolveAvailableInboxSources([...ownerEnabled], stored);
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

      for (const cfg of OAUTH_PROVIDER_CATALOG) {
        const key = inboxCapabilityPreferenceKey(cfg.providerName);
        if (!(key in patch) || patch[key] === false) continue;
        const allowed = await isCapabilityAllowedForPrincipal(
          grantStore,
          member.tenantId,
          member.principalId,
          cfg.providerName,
        );
        if (!allowed) {
          return c.json({ error: "Capability not available" }, 403);
        }
      }

      const merged = await mergeMemberPreferences(
        db,
        member.tenantId,
        member.principalId,
        patch,
      );

      // Self-service enablement (CL-3510): toggling `inbox.capability.<provider>`
      // writes/revokes the member's per-principal capability grant so the
      // toggle has real effect (least privilege — exactly that provider,
      // revoked on toggle-off). Only providers present in this patch are
      // touched; the rest are left as-is.
      for (const cfg of OAUTH_PROVIDER_CATALOG) {
        const key = inboxCapabilityPreferenceKey(cfg.providerName);
        if (!(key in patch)) continue;
        await setPrincipalCapabilityGrant(db, {
          tenantId: member.tenantId,
          principalId: member.principalId,
          provider: cfg.providerName,
          enabled: patch[key] !== false,
        });
      }
      return c.json(merged);
    },
  );

  return app;
}
