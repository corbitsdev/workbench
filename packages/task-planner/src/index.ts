export {
  assembleInventory,
  type InventoryAgent,
  type InventoryModel,
  type InventorySkill,
  type InventorySources,
  type InventoryToolPackage,
  type PlannerInventory,
} from "./inventory";
export {
  parseTaskSpec,
  validateTaskSpecAgainstInventory,
  PlannerReferenceOutOfInventoryError,
  PlannerReplyUnparseableError,
  TaskSpec,
} from "./task-spec";
export {
  runOneShotFoldedPrompt,
  OneShotDefinitionNotFoundError,
  PlannerRunFailedError,
  PlannerRunTimedOutError,
  type OneShotPromptInput,
  type OneShotReply,
  type OneShotRunnerDeps,
} from "./one-shot-reply";
export {
  runPlanner,
  resolveMyraDefinitionIdFromDb,
  PlannerMyraUnavailableError,
  type PlannerRunDeps,
  type PlannerRunResult,
} from "./planner-run";
export {
  spawnFromTaskSpec,
  type SpawnDeps,
  type SpawnFromTaskSpecInput,
} from "./spawn";
export {
  createPlannerRoutes,
  type CreatePlannerRoutesDeps,
  type DispatchWithPlannerResult,
} from "./routes";

import { runPlanner, type PlannerRunDeps } from "./planner-run";
import { spawnFromTaskSpec, type SpawnDeps } from "./spawn";
import type { DispatchWithPlannerResult } from "./routes";

/**
 * Composes `runPlanner` then `spawnFromTaskSpec`: turns a typed outcome
 * into a validated `TaskSpec`, then dispatches it exactly like a
 * manually-launched task. Any failure from either half propagates
 * unchanged — see each function's own doc for its specific error
 * classes.
 */
export async function dispatchWithPlanner(
  deps: PlannerRunDeps & SpawnDeps,
  input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly outcome: string;
  },
): Promise<DispatchWithPlannerResult> {
  const { spec, plannerRunId, inventory } = await runPlanner(deps, input);
  const task = await spawnFromTaskSpec(deps, {
    tenantId: input.tenantId,
    principalId: input.principalId,
    spec,
    plannerRunId,
  });
  return { task, plannerRunId, inventory };
}
