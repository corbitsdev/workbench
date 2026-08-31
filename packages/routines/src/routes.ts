// The HTTP surface of `@corbits/routines`: CRUD over routines, run
// history, and "run now" — mounted by the hub inside its tenant-scoped
// middleware, the same convention `@corbits/chat`'s routes use.
//
// "Run now" and a scheduled fire are the same launcher call
// (`deps.launcher.launchRoutineRun`) with a different `triggeredBy`;
// this module never grows a second launch path for the unscheduled
// case. Launch + correlation write is one shared helper so a silent
// orphan (launch succeeded, correlation lost) is impossible.
import { Hono } from "hono";
import { type } from "arktype";

import type { TenantEnv } from "@intx/hub-api";
import type { RequireGrant } from "@intx/hub-api";
import { idResource } from "@intx/hub-api";
import { getLogger } from "@intx/log";
import { generateId } from "@intx/hub-common";
import {
  FoldedRunFailedError,
  FoldedRunTimedOutError,
  OneShotDefinitionNotFoundError,
} from "@corbits/folded-run-one-shot";

import { RoutineTrigger, type RoutineTriggerT } from "./trigger";
import { routineScheduleSentence } from "./schedule-language";
import type {
  RoutineRow,
  RoutineRunRow,
  RoutineStore,
  UpdateRoutineInput,
} from "./store";
import { makeErrorEnvelope } from "@workbench/hub-client";
import {
  MyraRoutineDraftingUnavailableError,
  RoutineDraftReferenceOutOfInventoryError,
  RoutineDraftReplyUnparseableError,
} from "./myra-drafting";

const log = getLogger(["routines", "routes"]);

export interface LaunchedRoutineRun {
  readonly runId: string;
}

/**
 * The launcher port: routines never launch a run themselves — they
 * hand the definition/input off to whatever launches folded runs on
 * the host (`@corbits/folded-runs` in this repo), then record the
 * correlation. Keeping this a port, not a direct dependency, is what
 * keeps `@corbits/routines` hosted-service-agnostic.
 *
 * A run's delivery is a message into `deliveryWorkbenchId`'s root
 * timeline — never a pre-opened thread. If a single run's delivery ever
 * needs more than one message, the FIRST message still lands on the
 * workbench root; any follow-up messages from that same run thread under
 * it via `inReplyToMessageId` (`@corbits/chat`'s send API already
 * supports this) rather than a thread minted ahead of the run, before
 * anyone knows whether the run will actually produce more than one
 * message.
 */
export interface RoutineLauncher {
  launchRoutineRun(input: {
    tenantId: string;
    principalId: string;
    definitionId: string;
    input: Record<string, unknown>;
    deliveryWorkbenchId?: string | null | undefined;
    runRef?: string | undefined;
    routineName?: string | undefined;
  }): Promise<LaunchedRoutineRun>;
}

/**
 * Optional port: posts a plain-text notice into a workbench through the
 * host's existing chat platform — the same path a human's web-UI
 * message takes (mirrors `slack-tag`'s own `SendMessage` port over
 * `@corbits/chat`'s `sendWorkbenchMessage`). Since grant-free
 * `routine_create`/`routine_update` no longer require human approval
 * (CL-6247), a routine created enabled or flipped to enabled posts one
 * of these into its delivery workbench so the people in that workbench
 * learn what just started running, honestly, without digging into the
 * global Routines page first (CL-6362). Omitted: no notice is posted,
 * unchanged from before this port existed.
 */
export interface WorkbenchNoticePort {
  postWorkbenchNotice(input: {
    tenantId: string;
    workbenchId: string;
    principalId: string;
    text: string;
  }): Promise<void>;
}

/**
 * Enriches a correlated run id with whatever summary the host's own
 * run-listing surface exposes (status, timing, ...). Optional: a host
 * that mounts routines without wiring this still gets bare run ids and
 * timestamps back from `GET /routines/:id/runs`.
 */
export interface RunSummaryResolver {
  resolveRunSummary(
    tenantId: string,
    runId: string,
  ): Promise<Record<string, unknown> | undefined>;
}

export type CreateRoutineRoutesDeps = {
  store: RoutineStore;
  launcher: RoutineLauncher;
  requireGrant: RequireGrant;
  runSummaryResolver?: RunSummaryResolver;
  /**
   * When provided, `POST /routines` rejects with 404 if the definition
   * is not in the request tenant. Tests may omit (always-allow).
   */
  definitionInTenant?: (
    tenantId: string,
    definitionId: string,
  ) => Promise<boolean>;
  /**
   * When provided, a `{kind: "webhook"}` trigger is rejected with 404
   * unless the referenced `@corbits/webhook-triggers` row exists in the
   * request tenant *and* points at the same `definitionId` the routine
   * itself is being created/updated with — a webhook trigger and the
   * routine it fires are two views of one binding, so the two ids
   * disagreeing is corruption, not a valid state. Tests may omit
   * (always-allow).
   */
  webhookTriggerInTenant?: (
    tenantId: string,
    webhookTriggerId: string,
    definitionId: string,
  ) => Promise<boolean>;
  /**
   * Whether a routine on this definition must carry a `deliveryWorkbenchId`
   * — `false` for a workflow whose result never posts to a workbench at
   * all (its result reaches only its creator's Inbox instead). Omitted
   * defaults every definition to
   * workbench-required, the behavior before this port existed — a host
   * that never wires it keeps every prior create/run-now/fire contract
   * unchanged. Consulted at create, at "run now", and at every
   * scheduled fire (`fireScheduledRoutine`'s own `deps` takes the same
   * port), so a routine can never end up silently missing the delivery
   * its own workflow actually needs, and never forced to collect a
   * workbench a workflow would just discard.
   */
  deliveryWorkbenchRequired?: (
    tenantId: string,
    definitionId: string,
  ) => Promise<boolean>;
  /**
   * Validates `input` against the definition's own declared
   * trigger-field contract (shape — every required field a non-empty
   * string — and, for an `"agent"`-kind field, that the value actually
   * resolves to a real taskable definition) before a routine is
   * created. This is the friendly, early rejection; the workflow's own
   * fire-time validation (a host's own launcher definition checks) is
   * the authoritative second line — omitting
   * this port never blocks create, matching every prior contract.
   */
  validateRoutineInput?: (
    tenantId: string,
    definitionId: string,
    input: Record<string, unknown>,
  ) => Promise<
    { readonly ok: true } | { readonly ok: false; readonly message: string }
  >;
  /**
   * Describe-to-agent drafting. When omitted, draft routes return 404.
   */
  drafts?: import("./drafts").RoutineDraftStore | undefined;
  drafting?: import("./drafts").RoutineDraftingPort | undefined;
  /** See `WorkbenchNoticePort`'s own doc comment. */
  workbenchNotice?: WorkbenchNoticePort | undefined;
};

const DRAFT_FAILED_MESSAGE =
  "Myra couldn't draft a routine from that. Try rephrasing, or build it from the catalog instead.";

/** Every fail-closed error the Myra drafting path (`./myra-drafting.ts`)
 * can throw — Myra unresolvable, the one-shot run timing out or
 * failing, an unparseable reply, an out-of-inventory reference — reads
 * as the same honest "couldn't draft" 422 to the person who typed the
 * description. Anything else is a platform fault and is re-thrown for
 * the host's own error handling to surface. */
function isDraftingFailure(err: unknown): boolean {
  return (
    err instanceof MyraRoutineDraftingUnavailableError ||
    err instanceof OneShotDefinitionNotFoundError ||
    err instanceof FoldedRunTimedOutError ||
    err instanceof FoldedRunFailedError ||
    err instanceof RoutineDraftReplyUnparseableError ||
    err instanceof RoutineDraftReferenceOutOfInventoryError
  );
}

const CreateRoutineBody = type({
  name: "string",
  definitionId: "string",
  trigger: RoutineTrigger,
  scope: "'personal' | 'bench'",
  "input?": "Record<string, unknown>",
  // Whether this is actually required depends on the definition's own
  // delivery mode (see `deliveryWorkbenchRequired`, checked below, after
  // parse) — a workflow that only ever delivers to its creator's Inbox
  // must never be forced to collect a workbench it would just discard.
  "deliveryWorkbenchId?": "string",
  "runOnceNow?": "boolean",
  // Present only for a template-minted routine (e.g. a
  // `DEFAULT_ROUTINE_PRESETS` entry seeded by `ensureDefaultRoutines`) —
  // see `RoutineStore.createRoutineIfAbsent`'s own doc comment for the
  // create-if-absent guarantee this unlocks. Absent for every
  // person-authored create, unchanged prior behavior.
  "presetKey?": "string",
});

const UpdateRoutineBody = type({
  "name?": "string",
  "trigger?": RoutineTrigger,
  "input?": "Record<string, unknown>",
  "enabled?": "boolean",
  "deliveryWorkbenchId?": "string",
});

const RunNowBody = type({
  "input?": "Record<string, unknown>",
});

const CreateDraftBody = type({
  prompt: "string",
  deliveryWorkbenchId: "string",
  scope: "'personal' | 'bench'",
});

/**
 * Optional body for approving a draft: when Myra's proposal didn't pin
 * a `definitionId` (a valid, honest outcome — see
 * `RoutineDraftingPort`'s own doc comment), the review UI collects one
 * from the person instead and sends it here, rather than leaving
 * Approve permanently disabled with no recovery. Omitted (or an empty
 * body) falls back to the draft's own `definitionId`, unchanged
 * behavior for a draft that already has one.
 */
const ApproveDraftBody = type({
  "definitionId?": "string",
});

/**
 * The wire shape for a routine — never a raw id-only reference, always
 * the name and structured trigger a UI can render directly, per the
 * platform's "no raw IDs on screen" floor. Exported: `./workflow-routine-routes.ts`
 * (Myra's own tenant-scoped routine surface) renders the exact same shape,
 * never a second, drifting view of a routine row.
 */
export function routineView(row: RoutineRow) {
  return {
    id: row.id,
    name: row.name,
    definitionId: row.definitionId,
    trigger: row.trigger,
    scope: row.scope,
    input: row.input,
    enabled: row.enabled,
    deliveryWorkbenchId: row.deliveryWorkbenchId,
    consecutiveFailures: row.consecutiveFailures,
    deadLetteredAt: row.deadLetteredAt?.toISOString() ?? null,
    nextFireAt: row.nextFireAt?.toISOString() ?? null,
    presetKey: row.presetKey,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function runView(
  row: RoutineRunRow,
  resolver: RunSummaryResolver | undefined,
) {
  const summary = await resolver?.resolveRunSummary(row.tenantId, row.runId);
  const base = {
    runId: row.runId,
    triggeredBy: row.triggeredBy,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
  return summary !== undefined ? { ...base, run: summary } : base;
}

/**
 * Launch then correlate. If the correlation write fails after a
 * successful launch, rethrow loudly with the run id in the message —
 * never silently orphan a platform run. Clears fire-failure counters
 * only after both steps succeed.
 *
 * A run's result always delivers as a message into `deliveryWorkbenchId`'s
 * root timeline — see `RoutineLauncher`'s own doc comment for the
 * multi-message contract.
 *
 * Exported: `./workflow-routine-routes.ts`'s "run now" reuses this exact
 * launch-then-correlate call, never a second launch path for Myra's own
 * tenant-scoped routine surface either.
 */
export async function launchAndCorrelate(
  deps: {
    store: RoutineStore;
    launcher: RoutineLauncher;
  },
  input: {
    tenantId: string;
    principalId: string;
    definitionId: string;
    input: Record<string, unknown>;
    routineId: string;
    triggeredBy: string;
    deliveryWorkbenchId: string | null;
    routineName?: string;
  },
): Promise<LaunchedRoutineRun> {
  const launched = await deps.launcher.launchRoutineRun({
    tenantId: input.tenantId,
    principalId: input.principalId,
    definitionId: input.definitionId,
    input: input.input,
    deliveryWorkbenchId: input.deliveryWorkbenchId,
    routineName: input.routineName,
  });
  try {
    await deps.store.recordRoutineRun({
      tenantId: input.tenantId,
      routineId: input.routineId,
      runId: launched.runId,
      triggeredBy: input.triggeredBy,
    });
  } catch (err) {
    throw new Error(
      `routine launch succeeded (run ${launched.runId}) but correlation write failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  await deps.store.clearFireFailures(input.routineId);
  return { runId: launched.runId };
}

/**
 * A `{kind: "once"}` trigger fires the instant its routine is created —
 * its `nextFireAt` is (and stays) `null` (see `computeNextFireAt`), so
 * no scheduler will ever pick it up; this is the only fire that routine
 * ever gets. A no-op for every other trigger shape.
 *
 * Launch failure must never fail the create itself — the routine row
 * already exists by the time this runs. A synthetic `once-failed` run
 * is recorded instead, mirroring `markFailedFire`'s own
 * `schedule-failed` convention, so the failure is visible in run
 * history without a second bookkeeping path or a misleading 500 on an
 * otherwise-successful create.
 *
 * Exported: `./workflow-routine-routes.ts`'s `POST /routines` (Myra's
 * own routine-management surface, the path a run-once routine is
 * minted through) calls this exact same helper after its own
 * `createRoutine`, never a second, drifting fire path.
 */
export async function fireOnceTriggerIfNeeded(
  deps: { store: RoutineStore; launcher: RoutineLauncher },
  input: { tenantId: string; principalId: string; row: RoutineRow },
): Promise<void> {
  const { row } = input;
  if (row.trigger === null || row.trigger.kind !== "once") return;
  try {
    await launchAndCorrelate(deps, {
      tenantId: input.tenantId,
      principalId: input.principalId,
      definitionId: row.definitionId,
      input: row.input,
      routineId: row.id,
      triggeredBy: "once",
      deliveryWorkbenchId: row.deliveryWorkbenchId,
      routineName: row.name,
    });
  } catch (err) {
    log.error(
      "Run-once launch failed for routine {routineId}; recording a " +
        "failed run rather than failing the create",
      { routineId: row.id, err },
    );
    await deps.store.recordRoutineRun({
      tenantId: input.tenantId,
      routineId: row.id,
      runId: generateId("workflowRun"),
      triggeredBy: "once-failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * `true` when `trigger` is not a webhook binding (nothing to check), or
 * when it is and the referenced webhook-triggers row checks out for this
 * tenant and definition. See `webhookTriggerInTenant`'s doc comment on
 * why the definition id must match.
 *
 * Exported: `./workflow-routine-routes.ts` runs the exact same check on
 * Myra's own create/update path, never a looser one.
 */
export async function webhookTriggerValid(
  deps: Pick<CreateRoutineRoutesDeps, "webhookTriggerInTenant">,
  tenantId: string,
  trigger: RoutineTriggerT,
  definitionId: string,
): Promise<boolean> {
  if (trigger === null || trigger.kind !== "webhook") return true;
  if (deps.webhookTriggerInTenant === undefined) return true;
  return deps.webhookTriggerInTenant(
    tenantId,
    trigger.webhookTriggerId,
    definitionId,
  );
}

/** Every definition defaults to workbench-required — see
 * `CreateRoutineRoutesDeps.deliveryWorkbenchRequired`'s own doc comment
 * for why an omitted port must never change prior behavior.
 *
 * Exported: `./workflow-routine-routes.ts` consults the same rule for
 * Myra's own create/run-now path.
 */
export async function isDeliveryWorkbenchRequired(
  deps: Pick<CreateRoutineRoutesDeps, "deliveryWorkbenchRequired">,
  tenantId: string,
  definitionId: string,
): Promise<boolean> {
  if (deps.deliveryWorkbenchRequired === undefined) return true;
  return deps.deliveryWorkbenchRequired(tenantId, definitionId);
}

/**
 * Posts the "created enabled" / "enabled" honest-notice — see
 * `WorkbenchNoticePort`'s own doc comment for why this exists. Silent
 * no-op when `workbenchNotice` isn't wired, or when the routine has
 * nowhere to deliver into; a delivery failure here is logged, never
 * thrown — the routine itself already exists (or was already updated)
 * by the time this runs, and a missed notice must not undo that.
 *
 * Exported: `./workflow-routine-routes.ts` (Myra's own routine surface,
 * where `routine_create`/`routine_update` fire this same honest notice)
 * reuses this exact helper, never a second, drifting wording.
 */
export async function postRoutineEnabledNotice(
  deps: Pick<CreateRoutineRoutesDeps, "workbenchNotice">,
  input: {
    tenantId: string;
    principalId: string;
    workbenchId: string | null;
    name: string;
    trigger: RoutineTriggerT;
    verb: "Created" | "Enabled";
  },
): Promise<void> {
  if (deps.workbenchNotice === undefined) return;
  if (input.workbenchId === null || input.workbenchId === "") return;
  // The schedule is its own sentence rather than a clause: it is written
  // for a reader ("At 09:00 (UTC)"), and splicing it mid-phrase would
  // either capitalise oddly or lowercase the timezone into nonsense.
  const text =
    `${input.verb} routine "${input.name}" — ` +
    `${routineScheduleSentence(input.trigger)}. Manage it from Routines.`;
  try {
    await deps.workbenchNotice.postWorkbenchNotice({
      tenantId: input.tenantId,
      workbenchId: input.workbenchId,
      principalId: input.principalId,
      text,
    });
  } catch (err) {
    log.error(
      "Failed to post routine-{verb} notice into workbench {workbenchId}",
      {
        verb: input.verb,
        workbenchId: input.workbenchId,
        err,
      },
    );
  }
}

export function createRoutineRoutes(
  deps: CreateRoutineRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  // A person can't have two "describe it, Myra drafts it" calls racing
  // at once — a real one-shot inference call with no other
  // serialization (CL-5917 wires a live `runOneShotFoldedPrompt`, not a
  // stub) — the same `inFlightPrincipals` guard shape other one-shot
  // drafting surfaces in this codebase use: a plain-language 409
  // rejection of a same-principal concurrent second request, released
  // in a `finally` once the first
  // settles. Single-principal-in-flight only; broader per-tenant rate
  // limiting is tracked separately as CL-5285. This Set is in-memory and
  // resets on process restart — it guards within a single running
  // instance only, never cluster-wide across replicas.
  const inFlightDraftingPrincipals = new Set<string>();

  app.post(
    "/routines",
    deps.requireGrant("workflow-run:*", "create"),
    async (c) => {
      const body = CreateRoutineBody(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid routine body: ${body.summary}`,
          }),
          400,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");

      if (deps.definitionInTenant !== undefined) {
        const owned = await deps.definitionInTenant(
          tenant.id,
          body.definitionId,
        );
        if (!owned) {
          return c.json(
            makeErrorEnvelope({
              code: "not_found",
              userMessage: "definition not found",
            }),
            404,
          );
        }
      }

      if (
        !(await webhookTriggerValid(
          deps,
          tenant.id,
          body.trigger,
          body.definitionId,
        ))
      ) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "webhook trigger not found",
          }),
          404,
        );
      }

      const needsDelivery =
        (await isDeliveryWorkbenchRequired(
          deps,
          tenant.id,
          body.definitionId,
        )) &&
        (body.deliveryWorkbenchId === undefined ||
          body.deliveryWorkbenchId === "");

      // No workbench named and none needed: fall through with a null
      // delivery workbench. A workbench is named: use it as-is. Delivery
      // required and nothing named: 400 — a routine's destination is
      // always a workbench the person picked, never one invented and
      // named after the routine (CL-6201's own auto-provisioning is gone;
      // see this file's git history for the removed `deliverySpace` port).
      if (needsDelivery) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: "deliveryWorkbenchId is required for this workflow",
          }),
          400,
        );
      }

      if (deps.validateRoutineInput !== undefined) {
        const validated = await deps.validateRoutineInput(
          tenant.id,
          body.definitionId,
          body.input ?? {},
        );
        if (!validated.ok) {
          return c.json(
            makeErrorEnvelope({
              code: "bad_request",
              userMessage: validated.message,
            }),
            400,
          );
        }
      }

      const deliveryWorkbenchId = body.deliveryWorkbenchId ?? null;

      let row: RoutineRow | undefined;
      let created = true;
      if (body.presetKey !== undefined) {
        const result = await deps.store.createRoutineIfAbsent({
          tenantId: tenant.id,
          name: body.name,
          definitionId: body.definitionId,
          trigger: body.trigger,
          scope: body.scope,
          input: body.input ?? {},
          // A seeded preset is born disabled: a schedule must never
          // start firing (or announce itself) just because a bench
          // was minted — the member enabling it is the announcement.
          enabled: false,
          deliveryWorkbenchId,
          createdBy: principal.id,
          presetKey: body.presetKey,
        });
        if (result.outcome !== "tombstoned") {
          row = result.row;
          created = result.outcome === "created";
        }
      } else {
        row = await deps.store.createRoutine({
          tenantId: tenant.id,
          name: body.name,
          definitionId: body.definitionId,
          trigger: body.trigger,
          scope: body.scope,
          input: body.input ?? {},
          deliveryWorkbenchId,
          createdBy: principal.id,
        });
      }

      // Lost the create-if-absent race (or this is a genuine re-seed):
      // the preset row already exists. A member deleted this preset's
      // routine: absence is their choice, so nothing is (re-)created —
      // 204. No fire, no notice: both already happened (or are about to
      // happen) on the winning request.
      if (row === undefined) {
        return c.body(null, 204);
      }

      if (!created) {
        return c.json(routineView(row), 200);
      }

      if (body.runOnceNow === true) {
        await launchAndCorrelate(
          { store: deps.store, launcher: deps.launcher },
          {
            tenantId: tenant.id,
            principalId: principal.id,
            definitionId: row.definitionId,
            input: row.input,
            routineId: row.id,
            triggeredBy: "manual",
            deliveryWorkbenchId: row.deliveryWorkbenchId,
            routineName: row.name,
          },
        );
      }

      await fireOnceTriggerIfNeeded(
        { store: deps.store, launcher: deps.launcher },
        { tenantId: tenant.id, principalId: principal.id, row },
      );

      if (row.enabled) {
        await postRoutineEnabledNotice(deps, {
          tenantId: tenant.id,
          principalId: principal.id,
          workbenchId: row.deliveryWorkbenchId,
          name: row.name,
          trigger: row.trigger,
          verb: "Created",
        });
      }

      return c.json(routineView(row), 201);
    },
  );

  app.get(
    "/routines",
    deps.requireGrant("workflow-run:*", "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const rows = await deps.store.listRoutines(tenant.id);
      return c.json({ items: rows.map(routineView) });
    },
  );

  app.get(
    "/routines/:id",
    deps.requireGrant(idResource("workflow-run", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const row = await deps.store.getRoutine(tenant.id, c.req.param("id"));
      if (row === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "routine not found",
          }),
          404,
        );
      }
      return c.json(routineView(row));
    },
  );

  app.patch(
    "/routines/:id",
    deps.requireGrant(idResource("workflow-run", "id"), "write"),
    async (c) => {
      const body = UpdateRoutineBody(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid routine patch: ${body.summary}`,
          }),
          400,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const routineId = c.req.param("id");
      const existing = await deps.store.getRoutine(tenant.id, routineId);
      if (existing === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "routine not found",
          }),
          404,
        );
      }

      if (
        body.trigger !== undefined &&
        !(await webhookTriggerValid(
          deps,
          tenant.id,
          body.trigger,
          existing.definitionId,
        ))
      ) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "webhook trigger not found",
          }),
          404,
        );
      }

      let patch: UpdateRoutineInput = {};
      if (body.name !== undefined) patch = { ...patch, name: body.name };
      if (body.trigger !== undefined) {
        patch = { ...patch, trigger: body.trigger };
      }
      if (body.input !== undefined) patch = { ...patch, input: body.input };
      if (body.enabled !== undefined) {
        patch = { ...patch, enabled: body.enabled };
      }
      if (body.deliveryWorkbenchId !== undefined) {
        patch = { ...patch, deliveryWorkbenchId: body.deliveryWorkbenchId };
      }

      const row = await deps.store.updateRoutine(tenant.id, routineId, patch);

      const isEnableFlip = body.enabled === true && !existing.enabled;
      if (isEnableFlip) {
        await postRoutineEnabledNotice(deps, {
          tenantId: tenant.id,
          principalId: principal.id,
          workbenchId: row.deliveryWorkbenchId,
          name: row.name,
          trigger: row.trigger,
          verb: "Enabled",
        });
      }

      return c.json(routineView(row));
    },
  );

  app.delete(
    "/routines/:id",
    deps.requireGrant(idResource("workflow-run", "id"), "write"),
    async (c) => {
      const tenant = c.get("tenant");
      const deleted = await deps.store.deleteRoutine(
        tenant.id,
        c.req.param("id"),
      );
      if (!deleted) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "routine not found",
          }),
          404,
        );
      }
      return c.body(null, 204);
    },
  );

  app.get(
    "/routines/:id/runs",
    deps.requireGrant(idResource("workflow-run", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const routineId = c.req.param("id");
      // Deliberately `getRoutineIncludingDeleted`, not `getRoutine`: a
      // deleted routine's run history stays reachable (see store.ts),
      // so only a *never-existed* id 404s here.
      const existing = await deps.store.getRoutineIncludingDeleted(
        tenant.id,
        routineId,
      );
      if (existing === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "routine not found",
          }),
          404,
        );
      }
      const rows = await deps.store.listRunsForRoutine(tenant.id, routineId);
      const items = await Promise.all(
        rows.map((row) => runView(row, deps.runSummaryResolver)),
      );
      return c.json({ items });
    },
  );

  app.post(
    "/routines/:id/run",
    deps.requireGrant(idResource("workflow-run", "id"), "create"),
    async (c) => {
      const body = RunNowBody(await c.req.json().catch(() => ({})));
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid run body: ${body.summary}`,
          }),
          400,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const routineId = c.req.param("id");
      const existing = await deps.store.getRoutine(tenant.id, routineId);
      if (existing === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "routine not found",
          }),
          404,
        );
      }

      // "Run now" is an unscheduled fire of the exact launcher a
      // scheduled trigger would call — the only difference is
      // `triggeredBy`, never a second launch code path.
      if (
        (await isDeliveryWorkbenchRequired(
          deps,
          tenant.id,
          existing.definitionId,
        )) &&
        (existing.deliveryWorkbenchId === null ||
          existing.deliveryWorkbenchId === "")
      ) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage:
              "routine has no deliveryWorkbenchId; set one before running",
          }),
          400,
        );
      }
      const launched = await launchAndCorrelate(
        { store: deps.store, launcher: deps.launcher },
        {
          tenantId: tenant.id,
          principalId: principal.id,
          definitionId: existing.definitionId,
          input: body.input ?? existing.input,
          routineId,
          triggeredBy: "manual",
          deliveryWorkbenchId: existing.deliveryWorkbenchId,
          routineName: existing.name,
        },
      );

      return c.json({ runId: launched.runId }, 201);
    },
  );

  // --- Describe-to-agent drafting (path b) ---

  app.post(
    "/routine-drafts",
    deps.requireGrant("workflow-run:*", "create"),
    async (c) => {
      if (deps.drafts === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "unavailable",
            userMessage: "Routine drafting is not configured on this hub.",
          }),
          503,
        );
      }
      const body = CreateDraftBody(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid draft body: ${body.summary}`,
          }),
          400,
        );
      }
      const tenant = c.get("tenant");
      const principal = c.get("principal");

      if (deps.drafting !== undefined) {
        if (inFlightDraftingPrincipals.has(principal.id)) {
          return c.json(
            makeErrorEnvelope({
              code: "dispatch_in_progress",
              userMessage: "Myra is already working on your last request.",
            }),
            409,
          );
        }
        inFlightDraftingPrincipals.add(principal.id);
      }

      try {
        const draft = await deps.drafts.createDraft({
          tenantId: tenant.id,
          prompt: body.prompt,
          deliveryWorkbenchId: body.deliveryWorkbenchId,
          scope: body.scope,
          createdBy: principal.id,
        });

        if (deps.drafting !== undefined) {
          let proposal: Awaited<ReturnType<typeof deps.drafting.propose>>;
          try {
            proposal = await deps.drafting.propose({
              tenantId: tenant.id,
              principalId: principal.id,
              prompt: body.prompt,
            });
          } catch (err) {
            log.error`routine drafting failed for tenant ${tenant.id}: ${
              err instanceof Error ? err.message : String(err)
            }`;
            if (isDraftingFailure(err)) {
              return c.json(
                makeErrorEnvelope({
                  code: "drafting_failed",
                  userMessage: DRAFT_FAILED_MESSAGE,
                }),
                422,
              );
            }
            throw err;
          }
          const reviewed = await deps.drafts.markReviewed(tenant.id, draft.id, {
            proposedSteps: proposal.steps,
            proposedTrigger: proposal.trigger ?? null,
            proposedName: proposal.name ?? null,
            definitionId: proposal.definitionId ?? null,
            autonomy: proposal.autonomy ?? null,
          });
          return c.json(draftView(reviewed), 201);
        }

        return c.json(draftView(draft), 201);
      } finally {
        inFlightDraftingPrincipals.delete(principal.id);
      }
    },
  );

  app.get(
    "/routine-drafts",
    deps.requireGrant("workflow-run:*", "read"),
    async (c) => {
      if (deps.drafts === undefined) {
        return c.json({ items: [] as const });
      }
      const tenant = c.get("tenant");
      const items = await deps.drafts.listDrafts(tenant.id);
      return c.json({ items: items.map(draftView) });
    },
  );

  app.get(
    "/routine-drafts/:id",
    deps.requireGrant(idResource("workflow-run", "id"), "read"),
    async (c) => {
      if (deps.drafts === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "unavailable",
            userMessage: "Routine drafting is not configured on this hub.",
          }),
          503,
        );
      }
      const tenant = c.get("tenant");
      const draft = await deps.drafts.getDraft(tenant.id, c.req.param("id"));
      if (draft === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "draft not found",
          }),
          404,
        );
      }
      return c.json(draftView(draft));
    },
  );

  app.post(
    "/routine-drafts/:id/approve",
    deps.requireGrant(idResource("workflow-run", "id"), "create"),
    async (c) => {
      if (deps.drafts === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "unavailable",
            userMessage: "Routine drafting is not configured on this hub.",
          }),
          503,
        );
      }
      const body = ApproveDraftBody(await c.req.json().catch(() => ({})));
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid approve body: ${body.summary}`,
          }),
          400,
        );
      }
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const draftId = c.req.param("id");
      const draft = await deps.drafts.getDraft(tenant.id, draftId);
      if (draft === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "draft not found",
          }),
          404,
        );
      }
      if (draft.status !== "reviewed") {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `draft is ${draft.status}; only reviewed drafts can be approved`,
          }),
          400,
        );
      }
      // A draft's own `definitionId` wins when set; otherwise the
      // review UI's own pick (Myra proposing steps with no workflow
      // pinned is a valid, honest outcome — see `RoutineDraftingPort`'s
      // doc comment) — never silently falling back to nothing pinned.
      const definitionId =
        body.definitionId !== undefined && body.definitionId !== ""
          ? body.definitionId
          : draft.definitionId;
      if (definitionId === null || definitionId === "") {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage:
              "draft has no definitionId; review must pin a workflow definition",
          }),
          400,
        );
      }
      if (deps.definitionInTenant !== undefined) {
        const owned = await deps.definitionInTenant(tenant.id, definitionId);
        if (!owned) {
          return c.json(
            makeErrorEnvelope({
              code: "not_found",
              userMessage: "definition not found",
            }),
            404,
          );
        }
      }
      // Defense in depth: `POST /routines` never lets a `{kind:
      // "webhook"}` trigger through without this same check
      // (`webhookTriggerValid`'s own doc comment explains why the two
      // ids must agree) — a drafted proposal is no more trusted than a
      // request body a person typed by hand, so approve runs the exact
      // same check, never a second, looser path.
      if (
        !(await webhookTriggerValid(
          deps,
          tenant.id,
          draft.proposedTrigger,
          definitionId,
        ))
      ) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "webhook trigger not found",
          }),
          404,
        );
      }
      const name =
        draft.proposedName !== null && draft.proposedName !== ""
          ? draft.proposedName
          : draft.prompt.slice(0, 80);
      const trigger = draft.proposedTrigger ?? null;
      const routine = await deps.store.createRoutine({
        tenantId: tenant.id,
        name,
        definitionId,
        trigger,
        scope: draft.scope,
        input:
          draft.autonomy !== null
            ? { draftedSteps: draft.proposedSteps, autonomy: draft.autonomy }
            : { draftedSteps: draft.proposedSteps },
        deliveryWorkbenchId: draft.deliveryWorkbenchId,
        createdBy: principal.id,
      });
      const approved = await deps.drafts.markApproved(
        tenant.id,
        draftId,
        routine.id,
      );
      return c.json(
        { draft: draftView(approved), routine: routineView(routine) },
        201,
      );
    },
  );

  app.post(
    "/routine-drafts/:id/discard",
    deps.requireGrant(idResource("workflow-run", "id"), "write"),
    async (c) => {
      if (deps.drafts === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "unavailable",
            userMessage: "Routine drafting is not configured on this hub.",
          }),
          503,
        );
      }
      const tenant = c.get("tenant");
      try {
        const draft = await deps.drafts.markDiscarded(
          tenant.id,
          c.req.param("id"),
        );
        return c.json(draftView(draft));
      } catch (err) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: err instanceof Error ? err.message : "discard failed",
          }),
          400,
        );
      }
    },
  );

  return app;
}

function draftView(row: import("./drafts").RoutineDraftRow) {
  return {
    id: row.id,
    prompt: row.prompt,
    status: row.status,
    proposedSteps: row.proposedSteps,
    proposedTrigger: row.proposedTrigger,
    proposedName: row.proposedName,
    definitionId: row.definitionId,
    deliveryWorkbenchId: row.deliveryWorkbenchId,
    scope: row.scope,
    autonomy: row.autonomy,
    approvedRoutineId: row.approvedRoutineId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Fires a scheduled routine exactly the way `POST /routines/:id/run`
 * fires a manual one — same `launcher.launchRoutineRun` call, same
 * `recordRoutineRun` bookkeeping — with `triggeredBy: "schedule"` the
 * only distinguishing fact. A cron/interval scheduler calls this
 * directly, tenant and routine already resolved; it never
 * re-implements the launch or the correlation write.
 */
export async function fireScheduledRoutine(
  deps: {
    store: RoutineStore;
    launcher: RoutineLauncher;
    deliveryWorkbenchRequired?: (
      tenantId: string,
      definitionId: string,
    ) => Promise<boolean>;
  },
  params: { tenantId: string; routine: RoutineRow },
): Promise<LaunchedRoutineRun> {
  if (!params.routine.enabled) {
    throw new Error(
      `routine ${params.routine.id} is disabled; a scheduler must not fire it`,
    );
  }
  if (
    (await isDeliveryWorkbenchRequired(
      deps,
      params.tenantId,
      params.routine.definitionId,
    )) &&
    (params.routine.deliveryWorkbenchId === null ||
      params.routine.deliveryWorkbenchId === "")
  ) {
    throw new Error(
      `routine ${params.routine.id} has no deliveryWorkbenchId; cannot fire`,
    );
  }
  return launchAndCorrelate(deps, {
    tenantId: params.tenantId,
    principalId: params.routine.createdBy,
    definitionId: params.routine.definitionId,
    input: params.routine.input,
    routineId: params.routine.id,
    triggeredBy: "schedule",
    deliveryWorkbenchId: params.routine.deliveryWorkbenchId,
    routineName: params.routine.name,
  });
}
