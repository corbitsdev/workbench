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

export { createRoutineRoutes, fireScheduledRoutine } from "./routes";
export type {
  CreateRoutineRoutesDeps,
  RoutineLauncher,
  LaunchedRoutineRun,
  RunSummaryResolver,
  DeliveryThreadPort,
} from "./routes";
