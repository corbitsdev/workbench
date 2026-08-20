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
// first inbound mail via `sendFoldedMailWithRetry` — the same seam
// `@corbits/webhook-triggers`' `launchWebhookTrigger` uses for its own
// rendered input (both hardened identically; see that file's own note).
// Both "run now" and a scheduled fire land here (see `@corbits/routines`'
// `launchAndCorrelate`), so this one call covers both; a
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
//
// One definition short-circuits this whole folded-run path:
// `RECURRING_TASK_ASSET_NAME` (`@corbits/workflow-catalog`) is the
// "Make this a routine" bridge (an Inbox action on a completed task
// result — apps/web/src/pages/inbox-page.tsx) — a task's own agent is
// conversational, never automatable, so it can never be a routine's
// `definitionId` itself. This placeholder definition exists only to give
// the Routines picker a real, automatable id to schedule; firing it
// never launches its own folded run at all. Instead, the routine's
// stored `agent`/`prompt` trigger-field input goes straight through
// `dispatchTask` — the exact same `@corbits/tasks` `launchTask` call
// `POST /tasks` uses — so a scheduled recurring task lands in the
// creator's Inbox exactly like a manual one, on the same launch path, no
// duplicated logic. A `deliveryWorkbenchId` picked on the routine (if any)
// is not used for this delivery: a task result never posts to a workbench,
// only to the Inbox.
import { and, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { tenant as tenantTable, workflowDefinition } from "@intx/db/schema";
import {
  domainOf,
  launchFoldedRun,
  readDefinitionProjection,
  readFoldedBody,
  sendFoldedMailWithRetry,
  type CryptoProviderCache,
  type FoldedRunsDeps,
} from "@corbits/folded-runs";
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import { formatRunAddress } from "@intx/types";
import type { AssetService } from "@intx/hub-sessions";
import { handleFromName } from "@corbits/chat";
import { renderRoutineInput, type RoutineLauncher } from "@corbits/routines";
import { RECURRING_TASK_ASSET_NAME } from "@corbits/workflow-catalog";
import type { LaunchTaskInput, TaskRecord } from "@corbits/tasks";

const log = getLogger(["hub", "routine-launcher"]);

export type CreateHubRoutineLauncherDeps = FoldedRunsDeps & {
  db: DB["db"];
  assetService: AssetService;
  cryptoProviderCache: CryptoProviderCache;
  /** The narrow port a fired recurring-task routine dispatches through
   * — hub wires this to `(input) => launchTask(taskLauncherDeps, input)`,
   * the same deps object `POST /tasks` calls with. Domain logic (what a
   * task launch is) stays entirely in `@corbits/tasks`; this port is
   * pure composition, same as every other dep here. */
  dispatchTask: (input: LaunchTaskInput) => Promise<TaskRecord>;
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

function recurringTaskFieldsFromInput(input: Record<string, unknown>): {
  agent: string;
  prompt: string;
} {
  const agent = input["agent"];
  const prompt = input["prompt"];
  if (typeof agent !== "string" || agent === "") {
    throw new Error(
      'recurring-task routine is missing its "agent" trigger-field input',
    );
  }
  if (typeof prompt !== "string" || prompt === "") {
    throw new Error(
      'recurring-task routine is missing its "prompt" trigger-field input',
    );
  }
  return { agent, prompt };
}

/**
 * Builds the hub's `RoutineLauncher`: every routine fire — "run now" or
 * scheduled — resolves to exactly this launch path, the same folded-run
 * launch every other agent instance in this hub goes through (except a
 * recurring-task routine, which dispatches through `dispatchTask`
 * instead — see this module's own doc comment).
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

      if (definitionRow.name === RECURRING_TASK_ASSET_NAME) {
        const { agent, prompt } = recurringTaskFieldsFromInput(input.input);
        const task = await deps.dispatchTask({
          tenantId: input.tenantId,
          principalId: input.principalId,
          definitionId: agent,
          prompt,
        });
        return { runId: task.runId };
      }

      const tenantRow = await deps.db.query.tenant.findFirst({
        where: eq(tenantTable.id, input.tenantId),
      });
      if (tenantRow === undefined) {
        throw new Error(`no tenant "${input.tenantId}"`);
      }

      const projection = await readDefinitionProjection(deps.db, definitionRow);
      const foldedBody = readFoldedBody(
        projection,
        definitionRow.grantRequirements,
      );

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

      // Empty/absent stored input keeps prior behavior: no mail, the
      // agent starts from its system prompt alone.
      const content = renderRoutineInput(input.input);
      if (content !== "") {
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
          log.error`routine run ${instanceId} launched but its stored input failed to deliver after ${result.attempts} attempts: ${reason}`;
        }
      }

      return { runId: instanceId };
    },
  };
}
