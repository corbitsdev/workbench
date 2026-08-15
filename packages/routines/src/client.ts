// Browser-safe Routines domain surface: wire schemas, HTTP path builders,
// and pure display helpers shared by any UI over `@corbits/routines`'
// routes (see ./routes.ts). No drizzle, postgres, or `@intx/hub-api`
// server import reaches this module — enforced by
// `bun run check:browser-safe-subpaths` (scripts/checks/browser-safe-
// subpaths.ts), not just by convention. Trigger validation
// (`RoutineTrigger` / `RoutineTriggerWire`, cadence labels, next-fire
// math) already lives in ./trigger and ./cron and is re-exported here
// so a browser caller has one import for the whole client surface.

import { type } from "arktype";

import { RoutineTriggerWire, type RoutineTriggerT } from "./trigger";

export { suggestRoutineNameFromPrompt } from "./suggest-name";
export {
  RoutineTrigger,
  RoutineTriggerWire,
  computeNextFireAt,
  cronExpressionForTrigger,
  isValidCronExpression,
  isValidTimeZone,
  routineCadenceLabel,
  routineCadenceSummary,
  routineMatchesModeFilter,
  routineTriggerCategory,
  ROUTINE_WEEKDAY_NAMES,
  timezoneForTrigger,
} from "./trigger";
export type {
  RoutineModeFilter,
  RoutineTriggerT,
  RoutineTriggerWireT,
} from "./trigger";

// Response schemas read a trigger with `RoutineTriggerWire`, not the
// strict `RoutineTrigger` — a routine already saved was already
// validated once; re-validating its cron/timezone narrows on every GET
// would let an old row a stricter check now disagrees with hard-fail
// parsing in the browser instead of just rendering. `RoutineTrigger`
// (strict) stays on `CreateRoutineInput`/`UpdateRoutineInput`/
// `CreateDraftInput` below, which describe what the client sends.
export const Routine = type({
  id: "string",
  name: "string",
  definitionId: "string",
  trigger: RoutineTriggerWire,
  scope: "'personal' | 'bench'",
  input: "Record<string, unknown>",
  enabled: "boolean",
  deliveryChannelId: "string | null",
  createdAt: "string",
  updatedAt: "string",
});
export type Routine = typeof Routine.infer;

export const RoutinesResponse = type({ items: Routine.array() });

export const RoutineRun = type({
  runId: "string",
  triggeredBy: "string",
  createdAt: "string",
  "run?": "Record<string, unknown>",
});
export type RoutineRun = typeof RoutineRun.infer;

export const RoutineRunsResponse = type({ items: RoutineRun.array() });

export const DraftedStep = type({
  title: "string",
  "detail?": "string",
});
export type DraftedStep = typeof DraftedStep.infer;

export const RoutineDraft = type({
  id: "string",
  prompt: "string",
  status: "'draft' | 'reviewed' | 'approved' | 'discarded'",
  proposedSteps: DraftedStep.array(),
  proposedTrigger: RoutineTriggerWire,
  proposedName: "string | null",
  definitionId: "string | null",
  deliveryChannelId: "string",
  scope: "'personal' | 'bench'",
  autonomy: "Record<string, unknown> | null",
  approvedRoutineId: "string | null",
  createdAt: "string",
  updatedAt: "string",
});
export type RoutineDraft = typeof RoutineDraft.infer;

export type CreateRoutineInput = {
  readonly name: string;
  readonly definitionId: string;
  readonly trigger: RoutineTriggerT;
  readonly scope: "personal" | "bench";
  readonly deliveryChannelId: string;
  readonly input?: Record<string, unknown>;
  readonly runOnceNow?: boolean;
};

export type UpdateRoutineInput = {
  readonly name?: string;
  readonly trigger?: RoutineTriggerT;
  readonly enabled?: boolean;
  readonly input?: Record<string, unknown>;
  readonly deliveryChannelId?: string;
};

export type CreateDraftInput = {
  readonly prompt: string;
  readonly deliveryChannelId: string;
  readonly scope: "personal" | "bench";
};

/** `GET/POST /api/tenants/:tenantId/routines`. */
export function routinesPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/routines`;
}

/** `GET/PATCH/DELETE /api/tenants/:tenantId/routines/:id`. */
export function routinePath(tenantId: string, id: string): string {
  return `${routinesPath(tenantId)}/${id}`;
}

/** `POST /api/tenants/:tenantId/routines/:id/run`. */
export function routineRunNowPath(tenantId: string, id: string): string {
  return `${routinePath(tenantId, id)}/run`;
}

/** `GET /api/tenants/:tenantId/routines/:id/runs`. */
export function routineRunsPath(tenantId: string, id: string): string {
  return `${routinePath(tenantId, id)}/runs`;
}

/** `GET/POST /api/tenants/:tenantId/routine-drafts`. */
export function routineDraftsPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/routine-drafts`;
}

/** `GET /api/tenants/:tenantId/routine-drafts/:id`. */
export function routineDraftPath(tenantId: string, id: string): string {
  return `${routineDraftsPath(tenantId)}/${id}`;
}

/** `POST /api/tenants/:tenantId/routine-drafts/:id/approve`. */
export function routineDraftApprovePath(tenantId: string, id: string): string {
  return `${routineDraftPath(tenantId, id)}/approve`;
}

/** `POST /api/tenants/:tenantId/routine-drafts/:id/discard`. */
export function routineDraftDiscardPath(tenantId: string, id: string): string {
  return `${routineDraftPath(tenantId, id)}/discard`;
}

export function routineCreatedToast(name: string): string {
  return `Routine created · ${name}`;
}

export function routineRunStartedToast(name: string): string {
  return `Run started · ${name}`;
}
