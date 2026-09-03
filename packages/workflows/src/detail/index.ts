// The lifecycle/detail symbols are the browser-safe `../client` barrel's
// canonical export site — re-exported here rather than redeclared, so
// there is exactly one place that owns this list and the two barrels
// cannot drift apart.
export {
  deriveWorkflowLifecycle,
  type DefinitionLifecycleRow,
  type WorkflowLifecycle,
  type WorkflowLifecycleResult,
  workflowNotLaunchableReason,
  workflowDetailPath,
  WorkflowDefinitionDetail,
  WorkflowDetailSource,
  WorkflowDetailStep,
} from "../client";
export {
  createWorkflowDetailRoute,
  type CreateWorkflowDetailRouteDeps,
} from "./detail-route";
