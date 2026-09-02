// @corbits/workflows browser-safe entry — no `@intx/*`, no `drizzle-orm`,
// no `hono`: the workflow source-tree constants, the definition-detail
// wire schema, and the pure lifecycle-copy helper a workflow's own page
// reads directly. `check:browser-safe-subpaths` walks the real import
// graph from here and fails if anything server-only leaks in.
export * from "./source";
export {
  workflowNotLaunchableReason,
  workflowDetailPath,
  WorkflowDefinitionDetail,
  WorkflowDetailSource,
  WorkflowDetailStep,
} from "./detail/definition-detail";
export {
  deriveWorkflowLifecycle,
  type DefinitionLifecycleRow,
  type WorkflowLifecycle,
  type WorkflowLifecycleResult,
} from "./detail/definition-lifecycle";
