// Every deployed, authored definition whose frozen projection carries a
// valid `ScheduleTrigger` cron — what `@corbits/workflow-schedule`'s cron
// emitter arms a tick for. The ops-table sibling
// (`listScheduledWorkflowDefinitions`) keeps `stopped` rows so a paused
// digest still renders; this one is the firing list, so it does not.
//
// `creatorPrincipalId` is the principal a tick's trigger mail is sent as,
// and `tenantDomain` its sending domain: a row missing either cannot be
// fired and is left out rather than launched under a guessed identity.
import { and, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import {
  tenant as tenantTable,
  workflowDefinition,
  workflowDefinitionVersion,
} from "@intx/db/schema";

import { scheduleCronFromProjection } from "./from-projection";

export type DeployedCronDefinition = {
  readonly definitionId: string;
  readonly tenantId: string;
  readonly tenantDomain: string;
  readonly creatorPrincipalId: string;
  readonly name: string;
  readonly cron: string;
};

export async function listDeployedCronDefinitions(
  db: DB["db"],
): Promise<readonly DeployedCronDefinition[]> {
  const rows = await db
    .select({
      definitionId: workflowDefinition.id,
      tenantId: workflowDefinition.tenantId,
      tenantDomain: tenantTable.domain,
      creatorPrincipalId: workflowDefinition.creatorPrincipalId,
      name: workflowDefinition.name,
      wireProjection: workflowDefinitionVersion.wireProjection,
    })
    .from(workflowDefinition)
    .innerJoin(
      workflowDefinitionVersion,
      and(
        eq(workflowDefinitionVersion.definitionId, workflowDefinition.id),
        eq(
          workflowDefinitionVersion.version,
          workflowDefinition.currentVersion,
        ),
      ),
    )
    .innerJoin(tenantTable, eq(tenantTable.id, workflowDefinition.tenantId))
    .where(
      and(
        eq(workflowDefinition.origin, "authored"),
        eq(workflowDefinition.status, "deployed"),
      ),
    );

  const deployed: DeployedCronDefinition[] = [];
  for (const row of rows) {
    if (row.creatorPrincipalId === null) continue;
    const cron = scheduleCronFromProjection(row.wireProjection);
    if (cron === undefined) continue;
    deployed.push({
      definitionId: row.definitionId,
      tenantId: row.tenantId,
      tenantDomain: row.tenantDomain,
      creatorPrincipalId: row.creatorPrincipalId,
      name: row.name,
      cron,
    });
  }
  return deployed;
}

/** The body of a scheduled tick's trigger mail. */
export const SCHEDULE_TICK_CONTENT = "Scheduled tick.";
