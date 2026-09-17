import { timeWindowEvaluator } from "@intx/authz";
import type { ConditionRegistry } from "@intx/types/authz";

/**
 * Grant conditions the hub evaluates on every mount that takes a
 * `conditionRegistry`. Nothing here is chat-specific: `time_window` is
 * `@intx/authz`'s own evaluator, matching the default `mountHubRoutes`
 * builds when no registry is supplied.
 */
export const grantConditionRegistry: ConditionRegistry = {
  time_window: timeWindowEvaluator,
};
