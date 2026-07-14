import { eq } from "drizzle-orm";
import { slackTeamTenantMapping } from "../db/schema";
import type { HubDb } from "../db";

/**
 * Record which tenant owns a Slack workspace (CL-3629). Called from the
 * owner Slack-enablement path once the tenant's bot token resolves a team id
 * via `auth.test`. `slack_team_id` is globally unique, so re-enabling Slack
 * for a different tenant with the same workspace reassigns the mapping
 * (last writer wins) rather than creating a second row.
 */
export async function upsertSlackTeamMapping(
  db: HubDb,
  tenantId: string,
  slackTeamId: string,
): Promise<void> {
  await db
    .insert(slackTeamTenantMapping)
    .values({ tenantId, slackTeamId })
    .onConflictDoUpdate({
      target: slackTeamTenantMapping.slackTeamId,
      set: { tenantId, updatedAt: new Date() },
    });
}

/**
 * Resolve the tenant that owns a Slack workspace from its `team_id`. Returns
 * null for an unmapped team — the webhook route treats that as "drop the
 * event", not an error.
 */
export async function resolveTenantForSlackTeam(
  db: HubDb,
  slackTeamId: string,
): Promise<string | null> {
  const row = await db.query.slackTeamTenantMapping.findFirst({
    where: eq(slackTeamTenantMapping.slackTeamId, slackTeamId),
  });
  return row?.tenantId ?? null;
}
