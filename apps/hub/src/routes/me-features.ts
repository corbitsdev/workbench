import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { MemberFeaturesResponse } from "@workbench/shared";
import { resolveCallerMember } from "../lib/tenant-provisioning";
import { listMemberFeatureStates } from "../lib/feature-grants";
import type { HubDb } from "../db";

/**
 * Member-readable feature enablement (CL-3823). Same truth as the runtime
 * kill switches (`isFeatureEnabledForTenant`); no toggle here — owner writes
 * stay on the owner capabilities route.
 */
export function createMeFeaturesRouter(
  db: HubDb,
): Hono<{ Variables: { userId: string } }> {
  const app = new Hono<{ Variables: { userId: string } }>();

  app.get(
    "/me/features",
    describeRoute({
      tags: ["Me"],
      summary: "Get feature enablement for the caller's primary tenant",
      description:
        "Whether each product feature (scheduler, triage, tasks-reconciler) is enabled for the tenant. Used by member settings to hide controls the owner has turned off.",
      responses: {
        200: {
          description: "Feature enablement states",
          content: {
            "application/json": { schema: resolver(MemberFeaturesResponse) },
          },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const member = await resolveCallerMember(db, userId);
      if (!member) {
        return c.json({ features: [] });
      }
      const features = await listMemberFeatureStates(db, member.tenantId);
      return c.json({ features });
    },
  );

  return app;
}
