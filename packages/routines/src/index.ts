export const ROUTINES_PACKAGE_NAME = "@corbits/routines";

export {
  RoutineTrigger,
  isValidCronExpression,
  isValidTimeZone,
  cronExpressionCanFire,
  cronExpressionForTrigger,
  computeNextFireAt,
  timezoneForTrigger,
  cronMatchesMinute,
  minuteKey,
  routineTriggerCategory,
  routineMatchesModeFilter,
} from "./trigger";
export type { RoutineTriggerT, RoutineModeFilter } from "./trigger";
export { nextCronFireAfter, MAX_LOOKAHEAD_MINUTES, zonedParts } from "./cron";
export { renderRoutineInput } from "./render-input";
export { suggestRoutineNameFromPrompt } from "./suggest-name";

export { routine, routineRun, routineDraft } from "./schema";

export { routineMigrations, applyRoutineMigrations } from "./migrations";
export type {
  RoutineMigration,
  ApplyRoutineMigrationsReport,
} from "./migrations";

export {
  createDrizzleRoutineStore,
  createInMemoryRoutineStore,
  MAX_ROUTINE_FIRE_FAILURES,
  ROUTINE_FIRE_BACKOFF_BASE_MS,
  ROUTINE_FIRE_BACKOFF_MAX_MS,
  backoffMsForFailure,
} from "./store";
export type {
  RoutineDb,
  RoutineScope,
  RoutineRow,
  RoutineRunRow,
  CreateRoutineInput,
  UpdateRoutineInput,
  RoutineStore,
  MarkFailedFireResult,
} from "./store";

export {
  createInMemoryDraftStore,
  createDrizzleDraftStore,
  nextDraftStatus,
  parseDraftStatus,
  DraftedStepSchema,
} from "./drafts";
export type {
  RoutineDraftStore,
  RoutineDraftRow,
  RoutineDraftingPort,
  DraftStatus,
  DraftedStep,
  CreateDraftInput,
  ReviewDraftInput,
  DraftDb,
} from "./drafts";

export {
  createMyraRoutineDrafting,
  assembleRoutineDraftInventory,
  parseRoutineDraftReply,
  validateRoutineDraftReplyAgainstInventory,
  MyraRoutineDraftingUnavailableError,
  RoutineDraftReferenceOutOfInventoryError,
  RoutineDraftReplyUnparseableError,
  RoutineDraftReply,
} from "./myra-drafting";
export type {
  RoutineDraftInventory,
  RoutineDraftInventoryAgent,
  RoutineDraftInventoryWorkflow,
  RoutineDraftInventorySources,
  RoutineDraftingRunnerDeps,
} from "./myra-drafting";

// "What is launchable" moved into @corbits/workflows (CL-7373 fold
// review): it is definition-domain logic, not a routine concern. Kept
// re-exported here so every existing `@corbits/routines` importer (this
// package's own `routes.ts`, `apps/hub`) needs no change.
export {
  pickLaunchableDefinition,
  resolveLaunchableDefinition,
  routineTargetRejection,
  RoutineTargetUnresolvableError,
} from "@corbits/workflows";
export type {
  LaunchableDefinitionCandidate,
  LaunchableDefinitionRejection,
  LaunchableDefinitionResolution,
  LaunchableDefinitionResolver,
} from "@corbits/workflows";

export { createRoutineRoutes, fireScheduledRoutine } from "./routes";
export type {
  CreateRoutineRoutesDeps,
  RoutineLauncher,
  LaunchedRoutineRun,
  RunSummaryResolver,
} from "./routes";

export { createWorkflowRoutineRoutes } from "./workflow-routine-routes";
export type {
  CreateWorkflowRoutineRoutesDeps,
  WorkflowRoutineRunScope,
  WorkflowRoutinesEnv,
  WorkflowRunAuthenticator as WorkflowRoutineRunAuthenticator,
} from "./workflow-routine-routes";

export {
  listLaunchableDefinitions,
  listRoutineTargets,
  routineTargetKind,
  InvalidRoutineTargetCursorError,
  ROUTINE_TARGETS_DEFAULT_LIMIT,
  ROUTINE_TARGETS_MAX_LIMIT,
} from "./targets";
export type {
  LaunchableDefinition,
  RoutineTargetsDeps,
  RoutineTargetsQuery,
  RoutineTargetsPage,
} from "./targets";
export { createRoutineTargetRoutes } from "./targets-route";
