// Adapts `@corbits/folded-runs`' `launchFoldedRun` to `@corbits/routines`'
// `RoutineLauncher` port. Mirrors `@corbits/chat`'s `launchInvite` path
// (packages/chat/src/platform-adapter.ts) exactly: look up the deployed
// workflow definition, read its folded body off the materialized asset,
// mint a fresh instance id and trigger address, and launch. Routines owns
// no launch machinery of its own — this file only wires the two packages
// together, per "apps stay generic; packages own the domain": the domain
// logic (what a folded run is, how a routine fires) lives in those
// packages, and this adapter is pure composition.
//
// After launch, a non-empty stored `input` (the stepper-collected
// topic/focus a routine's creator recorded) is delivered as the run's
// first inbound mail via `sendFoldedMail` — the same seam
// `@corbits/webhook-triggers`' `launchWebhookTrigger` uses for its own
// rendered input. Both "run now" and a scheduled fire land here (see
// `@corbits/routines`' `launchAndCorrelate`), so this one call covers
// both; a webhook-triggered routine's fire never reaches this adapter at
// all (`launchWebhookTrigger` launches directly), so its own input
// delivery is that package's concern, not this one's.
import { and, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { tenant as tenantTable, workflowDefinition } from "@intx/db/schema";
import {
  domainOf,
  launchFoldedRun,
  readDefinitionJSON,
  readFoldedBody,
  sendFoldedMail,
  type CryptoProviderCache,
  type FoldedRunsDeps,
} from "@corbits/folded-runs";
import { generateId } from "@intx/hub-common";
import { formatRunAddress } from "@intx/types";
import type { AssetService } from "@intx/hub-sessions";
import { renderRoutineInput, type RoutineLauncher } from "@corbits/routines";

export type CreateHubRoutineLauncherDeps = FoldedRunsDeps & {
  db: DB["db"];
  assetService: AssetService;
  cryptoProviderCache: CryptoProviderCache;
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

      const launched = await launchFoldedRun(deps, {
        tenantId: input.tenantId,
        instanceId,
        triggerAddress,
        definitionId: input.definitionId,
        foldedBody,
        launchLabel: "a routine",
      });

      // Empty/absent stored input keeps prior behavior: no mail, the
      // agent starts from its system prompt alone.
      const content = renderRoutineInput(input.input);
      if (content !== "") {
        const cryptoProvider = await deps.cryptoProviderCache.get(instanceId);
        await sendFoldedMail(deps, {
          tenantId: input.tenantId,
          sessionId: launched.sessionId,
          agentAddress: triggerAddress,
          from: `${input.principalId}@${tenantRow.domain}`,
          domain: domainOf(triggerAddress),
          content,
          cryptoProvider,
        });
      }

      return { runId: instanceId };
    },
  };
}
