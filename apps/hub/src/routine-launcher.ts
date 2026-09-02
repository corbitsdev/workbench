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
// After launch, the routine's stored `input` (the stepper-collected
// topic/focus a routine's creator recorded), or a placeholder when it
// stored none, is delivered as the run's first inbound mail via
// `sendFoldedMailWithRetry` — the same seam `@corbits/webhook-triggers`'
// `launchWebhookTrigger` uses for its own rendered input (both hardened
// identically; see that file's own note). The mail is never optional: the
// run deploys under `AGENT_SECTION_MODE`, an `onTrigger` section whose
// one and only occurrence starts in response to an inbound mail, so a
// routine with no stored input still needs a real message to ever run a
// turn (CL-6678). Both "run now" and a scheduled fire land here (see
// `@corbits/routines`' `launchAndCorrelate`), so this one call covers both; a
// webhook-triggered routine's fire never reaches this adapter at all
// (`launchWebhookTrigger` launches directly), so its own input delivery
// is that package's concern, not this one's.
//
// A run is already real (principal/session/workflow_run rows committed,
// the sidecar deployed) the moment `launchFoldedRun` returns, so a
// delivery failure past that point must never un-launch it or hide it
// from `@corbits/routines`' correlation (`GET /routines/:id/runs`) —
// this function still returns the run id on a delivery failure, after
// exhausting `sendFoldedMailWithRetry`'s bounded retries, and only logs
// (naming the run) rather than throwing.
import { and, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { tenant as tenantTable, workflowDefinition } from "@intx/db/schema";
import { reportError } from "@corbits/error-sink";
import {
  domainOf,
  launchFoldedRun,
  readDefinitionProjection,
  readFoldedBody,
  sendFoldedMailWithRetry,
  MultiStepFoldUnsupportedError,
  type CryptoProviderCache,
  type FoldedRunsDeps,
} from "@corbits/folded-runs";
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import { formatRunAddress } from "@intx/types";
import type { AssetService } from "@intx/hub-sessions";
import {
  AGENT_SECTION_MODE,
  handleFromName,
  recordSourcesDigest,
  workbenchLaunchPersistExtra,
} from "@corbits/chat";
import {
  renderRoutineInput,
  resolveLaunchableDefinition,
  RoutineTargetUnresolvableError,
  type RoutineLauncher,
} from "@corbits/routines";
import { triggerNativeWorkflowRoutineRun } from "./native-workflow-routine-launch";

const log = getLogger(["hub", "routine-launcher"]);

export type CreateHubRoutineLauncherDeps = FoldedRunsDeps & {
  db: DB["db"];
  assetService: AssetService;
  cryptoProviderCache: CryptoProviderCache;
  /** Adds the launched run's address to the routine's delivery workbench
   * as a participant — hub wires this to `@corbits/chat`'s
   * `joinRunParticipant`. Membership is what makes the chat
   * orchestrator post the run's replies into that workbench: a routine
   * delivers into a workbench through the exact same participant path
   * an invited agent's replies take, never a second posting mechanism. */
  joinDeliveryWorkbench: (input: {
    tenantId: string;
    workbenchId: string;
    principalId: string;
    address: string;
    handle: string;
  }) => Promise<void>;
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
      const resolution = await resolveLaunchableDefinition({
        db: deps.db,
        tenantId: input.tenantId,
        definitionAssetId: input.definitionAssetId,
      });
      if (!resolution.ok) {
        reportError(
          new RoutineTargetUnresolvableError(
            input.definitionAssetId,
            resolution.reason,
          ),
          {
            operation: "routine-launcher.launchRoutineRun",
            tenantId: input.tenantId,
            extra: { definitionAssetId: input.definitionAssetId },
          },
        );
        throw new RoutineTargetUnresolvableError(
          input.definitionAssetId,
          resolution.reason,
        );
      }
      const definitionId = resolution.definitionId;

      const definitionRow = await deps.db.query.workflowDefinition.findFirst({
        where: and(
          eq(workflowDefinition.id, definitionId),
          eq(workflowDefinition.tenantId, input.tenantId),
        ),
      });
      if (
        definitionRow === undefined ||
        definitionRow.status !== "deployed" ||
        definitionRow.assetId === null
      ) {
        const reason =
          definitionRow === undefined ? "not_found" : "not_deployed";
        reportError(
          new RoutineTargetUnresolvableError(input.definitionAssetId, reason),
          {
            operation: "routine-launcher.launchRoutineRun",
            tenantId: input.tenantId,
            extra: { definitionAssetId: input.definitionAssetId, definitionId },
          },
        );
        throw new RoutineTargetUnresolvableError(
          input.definitionAssetId,
          reason,
        );
      }

      const tenantRow = await deps.db.query.tenant.findFirst({
        where: eq(tenantTable.id, input.tenantId),
      });
      if (tenantRow === undefined) {
        throw new Error(`no tenant "${input.tenantId}"`);
      }

      const projection = await readDefinitionProjection(deps.db, definitionRow);

      // A multi-step definition can only exist as a code-sourced
      // `@intx/workflow` deployed through `POST /workflows/deployments`
      // (see `native-workflow-routine-launch.ts`'s own header) — it never
      // reaches `readFoldedBody` successfully, because that reader's
      // deploy target has no notion of step order at all. Route it onto
      // Interchange's native workflow-run trigger instead of throwing
      // the folded path's 500: this is a deliberate split by definition
      // shape, not two launchers competing for the same case — a
      // single-step, hand-authored definition has no source of its own
      // and still needs `launchFoldedRun`'s render-and-deploy bridge
      // below; a multi-step definition already has real, deployed
      // source and only needs firing.
      let foldedBody;
      try {
        foldedBody = readFoldedBody(
          projection,
          definitionRow.grantRequirements,
        );
      } catch (err) {
        if (!(err instanceof MultiStepFoldUnsupportedError)) throw err;
        const content = renderRoutineInput(input.input);
        const triggered = await triggerNativeWorkflowRoutineRun(deps, {
          tenantId: input.tenantId,
          definitionId,
          principalId: input.principalId,
          fromDomain: tenantRow.domain,
          // A native run only starts on its first trigger mail — unlike
          // a folded run, there is no "start from the system prompt
          // alone" fallback, so an empty stored input still needs a
          // real message to fire the deployment.
          content: content === "" ? "Run this routine now." : content,
        });

        if (
          input.deliveryWorkbenchId !== undefined &&
          input.deliveryWorkbenchId !== null &&
          input.deliveryWorkbenchId !== ""
        ) {
          try {
            await deps.joinDeliveryWorkbench({
              tenantId: input.tenantId,
              workbenchId: input.deliveryWorkbenchId,
              principalId: input.principalId,
              address: triggered.address,
              handle: handleFromName(
                input.routineName ?? "",
                triggered.address,
              ),
            });
          } catch (joinErr) {
            const reason =
              joinErr instanceof Error ? joinErr.message : String(joinErr);
            log.error`routine run ${triggered.runId} launched but could not join delivery workbench ${input.deliveryWorkbenchId}: ${reason}`;
          }
        }

        return { runId: triggered.runId };
      }

      const instanceId = generateId("workflowRun");
      const triggerAddress = formatRunAddress(instanceId, tenantRow.domain);

      const launched = await launchFoldedRun(deps, {
        tenantId: input.tenantId,
        instanceId,
        triggerAddress,
        definitionId,
        foldedBody,
        launchLabel: "a routine",
        // The same `onTrigger` section shape and stable-id → current-run
        // mapping every room-invited agent launches with (CL-6367):
        // without the mapping row, a routine run that dies with its
        // sidecar could never be relaunched — chat's terminal sweep and
        // wake path both resolve through it.
        mode: AGENT_SECTION_MODE,
        persistExtra: workbenchLaunchPersistExtra({
          tenantId: input.tenantId,
          instanceId,
          foldedBody,
        }),
      });
      await recordSourcesDigest(deps.db, instanceId, launched.sourcesDigest);

      if (
        input.deliveryWorkbenchId !== undefined &&
        input.deliveryWorkbenchId !== null &&
        input.deliveryWorkbenchId !== ""
      ) {
        try {
          await deps.joinDeliveryWorkbench({
            tenantId: input.tenantId,
            workbenchId: input.deliveryWorkbenchId,
            principalId: input.principalId,
            address: triggerAddress,
            handle: handleFromName(input.routineName ?? "", triggerAddress),
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          log.error`routine run ${instanceId} launched but could not join delivery workbench ${input.deliveryWorkbenchId}: ${reason}`;
        }
      }

      // The run just deployed under AGENT_SECTION_MODE — an `onTrigger`
      // section (CL-6329/CL-6367) whose one and only occurrence starts
      // in response to an inbound mail. Unlike the pre-CL-6367 `step`
      // shape, there is no "start from the system prompt alone"
      // fallback: skipping mail here leaves the section permanently
      // un-triggered (deployed, zero occurrences, forever "running" —
      // CL-6678). Mirror `triggerNativeWorkflowRoutineRun`'s own
      // empty-content substitution so a routine with no separately
      // stored input still fires.
      const renderedContent = renderRoutineInput(input.input);
      const content =
        renderedContent === "" ? "Run this routine now." : renderedContent;
      const cryptoProvider = await deps.cryptoProviderCache.get(instanceId);
      const result = await sendFoldedMailWithRetry(deps, {
        tenantId: input.tenantId,
        sessionId: launched.sessionId,
        agentAddress: triggerAddress,
        from: `${input.principalId}@${tenantRow.domain}`,
        domain: domainOf(triggerAddress),
        content,
        cryptoProvider,
      });
      if (!result.ok) {
        const reason =
          result.error instanceof Error
            ? result.error.message
            : String(result.error);
        log.error`routine run ${instanceId} launched but its trigger mail failed to deliver after ${result.attempts} attempts: ${reason}`;
      }

      return { runId: instanceId };
    },
  };
}
