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
// Re-exported from `@corbits/folded-runs` (where `runOneShotFoldedPrompt`
// now lives, CL-6051 finding 12) rather than dropped: this package's own
// `./routes.ts` and `./planner-run.ts` are already this barrel's
// established shape, so callers of `@corbits/task-planner` keep one
// import surface instead of reaching into a second package for names
// this package's own errors and routes still speak in terms of.
export {
  runOneShotFoldedPrompt,
  OneShotDefinitionNotFoundError,
  FoldedRunFailedError,
  FoldedRunTimedOutError,
  type OneShotPromptInput,
  type OneShotReply,
  type OneShotRunnerDeps,
} from "@corbits/folded-runs";
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
