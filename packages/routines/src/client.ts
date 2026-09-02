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
import { slugify } from "@corbits/slug";

import { RoutineTriggerWire, type RoutineTriggerT } from "./trigger";

export { suggestRoutineNameFromPrompt } from "./suggest-name";
export {
  cronHasWallClock,
  cronSentence,
  routineScheduleSentence,
} from "./schedule-language";
export {
  fireNeverStarted,
  runStatusLabel,
  triggeredByLabel,
} from "./run-language";
export {
  cleanFireStreak,
  FIRE_RUNNING_WINDOW_MS,
  fireFailed,
  fireOutcomeStatus,
  lastFailedFire,
  medianFireDurationMs,
  routineHealth,
} from "./health";
export type {
  RoutineFire,
  RoutineHealth,
  RoutineHealthState,
  RoutineHealthSubject,
} from "./health";
export {
  RoutineTrigger,
  RoutineTriggerWire,
  computeNextFireAt,
  cronExpressionForTrigger,
  cronTriggerForWeekdays,
  isValidCronExpression,
  isValidTimeZone,
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
  // The routine's target: the workflow asset it follows across redeploys
  // (stable identity), and the definition that would run right now —
  // `null` when no deployed, approved definition currently resolves for
  // that asset, which a UI should say plainly rather than hide.
  definitionAssetId: "string",
  definitionId: "string | null",
  trigger: RoutineTriggerWire,
  scope: "'personal' | 'bench'",
  input: "Record<string, unknown>",
  enabled: "boolean",
  deliveryWorkbenchId: "string | null",
  // How many scheduled fires have failed in a row (reset to 0 on any
  // successful fire, including "run now" — see store.ts). Zero means
  // healthy, regardless of `deadLetteredAt`.
  consecutiveFailures: "number",
  // Set once `consecutiveFailures` reaches `MAX_ROUTINE_FIRE_FAILURES`
  // — the scheduler stops claiming this routine until a person
  // re-enables or edits it. `null` means still scheduling normally.
  deadLetteredAt: "string | null",
  // The scheduler's own due-fire clock, surfaced rather than recomputed:
  // a UI that re-derives "next run" from the trigger is guessing, while
  // this is the instant the scheduler will actually test against. `null`
  // for a routine that never auto-fires (manual, webhook, run-once) or
  // one that is disabled or dead-lettered.
  //
  // Optional for exactly one release, on purpose: a browser that has
  // already loaded the new bundle can be talking to a hub that has not
  // shipped this field yet, and a required field would make arktype
  // reject the whole routines payload — blanking every routines surface
  // over a display-only value. Tightening to required once the hub is
  // known-upgraded is its own follow-up ticket; until then the reader
  // treats absent and null alike ("not scheduled" is the honest reading
  // of "the server didn't say").
  //
  // There is deliberately no `lastFireAt` here. The store writes it only
  // on a scheduled claim, so a run-now-only routine would report "never
  // run" beside a history table full of runs. "Last run" has one
  // definition — the newest row of the fire history — and it lives in
  // ./health.ts.
  "nextFireAt?": "string | null",
  createdAt: "string",
  updatedAt: "string",
});
export type Routine = typeof Routine.infer;

/**
 * A routine's URL-facing name, for `/routines/<slug>`. Derived from the
 * display name rather than stored: routines predate slug-addressed detail
 * routes and carry no slug column, and DESIGN.md's rule for exactly this
 * case is that a route without a guaranteed-unique slug falls back to an
 * opaque id — which `/routines/<id>` already is, since an id (`rtn_1`) is
 * not slug-shaped and so resolves to the roster instead. Empty string for
 * a name with nothing sluggable in it (emoji, a non-Latin script); a
 * caller renders that routine without a detail link rather than linking
 * to a path that cannot resolve.
 */
export function routineSlug(name: string): string {
  return slugify(name);
}

export const RoutinesResponse = type({ items: Routine.array() });

export const RoutineRun = type({
  runId: "string",
  triggeredBy: "string",
  createdAt: "string",
  // Set on a synthetic `schedule-failed` run row (see store.ts) — the
  // launch failure's own message, so a dead-lettered routine's detail
  // can show *why*, not just *that* it stopped.
  "error?": "string | null",
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
  definitionAssetId: "string | null",
  deliveryWorkbenchId: "string",
  scope: "'personal' | 'bench'",
  autonomy: "Record<string, unknown> | null",
  approvedRoutineId: "string | null",
  createdAt: "string",
  updatedAt: "string",
});
export type RoutineDraft = typeof RoutineDraft.infer;

export type CreateRoutineInput = {
  readonly name: string;
  /** The workflow asset this routine runs — always named explicitly by
   * the caller; the server never infers a target. */
  readonly definitionAssetId: string;
  readonly trigger: RoutineTriggerT;
  readonly scope: "personal" | "bench";
  /** Omitted only for a workflow whose result never posts to a workbench
   * (see `@corbits/workflow-catalog`'s `WorkflowCatalogEntry.deliveryMode`)
   * — the server itself still rejects a missing value for every other
   * workflow (`deliveryWorkbenchRequired`, routes.ts). */
  readonly deliveryWorkbenchId?: string;
  readonly input?: Record<string, unknown>;
  readonly runOnceNow?: boolean;
};

export type UpdateRoutineInput = {
  readonly name?: string;
  readonly trigger?: RoutineTriggerT;
  readonly enabled?: boolean;
  readonly input?: Record<string, unknown>;
  readonly deliveryWorkbenchId?: string;
  /** Retargets the routine to a different workflow asset (CL-7358) — the
   * server validates it through `routineTargetRejection` (`./target.ts`)
   * before applying, and rejects a stale/cross-tenant/undeployed asset. */
  readonly definitionAssetId?: string;
};

export type CreateDraftInput = {
  readonly prompt: string;
  readonly deliveryWorkbenchId: string;
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

// One deployed, frozen definition a routine may target
// (`GET /api/tenants/:tenantId/workflows/targets`, see ./targets.ts).
// `definitionAssetId` is the stable identity a routine stores;
// `definitionId`/`wireHash` name the row that would run right now.
// `kind` groups the picker without changing execution semantics: an
// "agent" is a single-step conversational fold, everything else a
// "workflow". `assetName` is the raw catalog key
// (`@corbits/workflow-catalog`'s `workflowCatalogEntry`); `name` is the
// display label.
export const RoutineTargetKind = type("'agent' | 'workflow'");
export type RoutineTargetKind = typeof RoutineTargetKind.infer;

export const RoutineTarget = type({
  definitionAssetId: "string",
  definitionId: "string",
  assetName: "string",
  name: "string",
  description: "string | null",
  kind: RoutineTargetKind,
  wireHash: "string",
});
export type RoutineTarget = typeof RoutineTarget.infer;

export const RoutineTargetsResponse = type({
  items: RoutineTarget.array(),
  nextCursor: "string | null",
});
export type RoutineTargetsResponse = typeof RoutineTargetsResponse.infer;

/** `GET /api/tenants/:tenantId/workflows/targets?limit=&cursor=`. */
export function routineTargetsPath(
  tenantId: string,
  query: { readonly cursor?: string; readonly limit?: number } = {},
): string {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  const suffix = params.size === 0 ? "" : `?${params.toString()}`;
  return `/api/tenants/${tenantId}/workflows/targets${suffix}`;
}

export function routineCreatedToast(name: string): string {
  return `Routine created · ${name}`;
}

export function routineRunStartedToast(name: string): string {
  return `Run started · ${name}`;
}

/**
 * A routine action that didn't happen has to say so. Every lifecycle
 * control on a routines surface is a write against a live hub that can
 * refuse it — a revoked grant, a routine deleted in another tab, an
 * expired session — and a control that swallows the refusal leaves a
 * person believing a schedule changed when it did not. `reason` is a
 * caller-supplied sentence (`describeApiError` in this repo's web app),
 * never a raw status line or a request path.
 */
const ROUTINE_ACTION_VERBS = {
  run: "start",
  pause: "pause",
  resume: "resume",
  schedule: "reschedule",
} as const;

export type RoutineAction = keyof typeof ROUTINE_ACTION_VERBS;

export function routineActionFailedToast(
  action: RoutineAction,
  name: string,
  reason: string,
): string {
  return `Couldn't ${ROUTINE_ACTION_VERBS[action]} ${name}. ${reason}`;
}
