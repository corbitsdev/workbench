export const ROUTINES_PACKAGE_NAME = "@corbits/routines";

export {
  RoutineTrigger,
  isValidCronExpression,
  cronExpressionForTrigger,
  computeNextFireAt,
  cronMatchesMinute,
  minuteKey,
} from "./trigger";
export type { RoutineTriggerT } from "./trigger";
export { nextCronFireAfter } from "./cron";

export { routine, routineRun } from "./schema";

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

export { createRoutineRoutes, fireScheduledRoutine } from "./routes";
export type {
  CreateRoutineRoutesDeps,
  RoutineLauncher,
  LaunchedRoutineRun,
  RunSummaryResolver,
} from "./routes";
