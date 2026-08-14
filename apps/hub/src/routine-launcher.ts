// Adapts `@corbits/folded-runs`' `launchFoldedRun` to `@corbits/routines`'
// `RoutineLauncher` port. Mirrors `@corbits/chat`'s `launchInvite` path
// (packages/chat/src/platform-adapter.ts) exactly: look up the deployed
// workflow definition, read its folded body off the materialized asset,
// mint a fresh instance id and trigger address, and launch. Routines owns
// no launch machinery of its own — this file only wires the two packages
// together, per "apps stay generic; packages own the domain": the domain
// logic (what a folded run is, how a routine fires) lives in those
// packages, and this adapter is pure composition.
import { and, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { tenant as tenantTable, workflowDefinition } from "@intx/db/schema";
import {
  launchFoldedRun,
  readDefinitionJSON,
  readFoldedBody,
  type FoldedRunsDeps,
} from "@corbits/folded-runs";
import { generateId } from "@intx/hub-common";
import { formatRunAddress } from "@intx/types";
import type { AssetService } from "@intx/hub-sessions";
import type { RoutineLauncher } from "@corbits/routines";

export type CreateHubRoutineLauncherDeps = FoldedRunsDeps & {
  db: DB["db"];
  assetService: AssetService;
};

/**
 * Builds the hub's `RoutineLauncher`: every routine fire — "run now" or
 * scheduled — resolves to exactly this launch path, the same folded-run
 * launch every other agent instance in this hub goes through.
 */
export function createHubRoutineLauncher(
  deps: CreateHubRoutineLauncherDeps,
): RoutineLauncher {
  return {
    async launchRoutineRun(input) {
      const definitionRow = await deps.db.query.workflowDefinition.findFirst({
        where: and(
          eq(workflowDefinition.id, input.definitionId),
          eq(workflowDefinition.tenantId, input.tenantId),
        ),
      });
      if (definitionRow === undefined) {
        throw new Error(
          `no definition "${input.definitionId}" for this tenant`,
        );
      }
      if (definitionRow.status !== "deployed") {
        throw new Error(
          `definition "${input.definitionId}" is not in a launchable ` +
            `state (status: ${definitionRow.status})`,
        );
      }
      if (definitionRow.assetId === null) {
        throw new Error(
          `definition "${input.definitionId}" has not been materialized`,
        );
      }

      const tenantRow = await deps.db.query.tenant.findFirst({
        where: eq(tenantTable.id, input.tenantId),
      });
      if (tenantRow === undefined) {
        throw new Error(`no tenant "${input.tenantId}"`);
      }

      const definitionJSON = await readDefinitionJSON(
        deps.assetService,
        definitionRow.assetId,
      );
      const foldedBody = readFoldedBody(definitionJSON);

      const instanceId = generateId("workflowRun");
      const triggerAddress = formatRunAddress(instanceId, tenantRow.domain);

      await launchFoldedRun(deps, {
        tenantId: input.tenantId,
        instanceId,
        triggerAddress,
        definitionId: input.definitionId,
        foldedBody,
        launchLabel: "a routine",
      });

      return { runId: instanceId };
    },
  };
}
