// Myra's own routine-management surface: the workflow-run-authenticated
// counterpart to `./routes.ts`'s tenant-session `createRoutineRoutes`,
// mirroring `@corbits/agent-directory`'s `createWorkflowCapabilityRoutes`
// (`packages/agent-directory/src/workflow-capability-routes.ts`) for the
// authentication shape: a workflow-process child has no browser session,
// only its sidecar bearer token and its own run address, so it
// authenticates through a `WorkflowRunAuthenticator` rather than the
// tenant-session pipeline `./routes.ts` uses. Mounted OUTSIDE the tenant
// prefix for that reason.
//
// Unlike `createWorkflowCapabilityRoutes` — which is scoped to a run's
// OWN definition only — this surface is scoped to the run's own TENANT:
// Myra may create or manage a routine targeting any workflow asset in
// her tenant, not just her own. `POST /routines` therefore validates the
// named target through the same `resolveTarget` rule the tenant-session
// route uses — an explicit asset id, never a name search or a
// same-definition-as-caller check.
//
// Authorization decision (same reasoning as `createWorkflowCapabilityRoutes`'s
// own file-level comment): this surface never calls `requireGrant`. A
// human is still the authorizer — but the gate is `@corbits/routines-tools`'
// `routine_create` / `routine_update` / `routine_run_now` tools declaring
// `approval: "ask"` (`@intx/agent`'s native per-invocation gate), which
// suspends the call as a pending approval and renders it in-chat BEFORE
// this route ever runs. By the time a request reaches here, a human
// already approved the specific routine action; a grant-store check would
// only be checking the same human's authority a second, redundant way.
// `routine_list` is the one read-only exception, and reads need no
// approval gate at all.
import { Hono } from "hono";
import { type } from "arktype";

import { RoutineTrigger } from "./trigger";
import type { RoutineStore, UpdateRoutineInput } from "./store";
import { makeErrorEnvelope } from "@workbench/hub-client";
import {
  fireOnceTriggerIfNeeded,
  isDeliveryWorkbenchRequired,
  launchAndCorrelate,
  postRoutineEnabledNotice,
  rejectUnlaunchableTarget,
  resolvedRoutineView,
  webhookTriggerValid,
  type WorkbenchNoticePort,
  type RoutineLauncher,
} from "./routes";
import { validateRetarget } from "./routine-operations";
import type { LaunchableDefinitionResolver } from "@corbits/workflows";
import {
  InvalidRoutineTargetCursorError,
  ROUTINE_TARGETS_DEFAULT_LIMIT,
  ROUTINE_TARGETS_MAX_LIMIT,
  type RoutineTargetsPage,
  type RoutineTargetsQuery,
} from "./targets";
import type { ConditionRegistry, GrantStore } from "@intx/types/authz";

const TargetsLimitParam = type("string.integer.parse").narrow(
  (limit) => limit >= 1 && limit <= ROUTINE_TARGETS_MAX_LIMIT,
);

/**
 * The tenant + principal + run a presented sidecar token and run address
 * resolve to. Declared structurally (mirroring
 * `@corbits/agent-directory`'s `WorkflowCapabilityRunScope`) rather than
 * importing a concrete authenticator's type, so this package carries no
 * dependency on whichever plane actually resolves sidecar tokens
 * (`@corbits/artifacts-hub`'s `createWorkflowRunAuthenticator` satisfies
 * this shape exactly).
 */
export type WorkflowRoutineRunScope = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly runId: string;
};

export type WorkflowRunAuthenticator = {
  resolve(
    token: string,
    runAddress: string,
  ): Promise<WorkflowRoutineRunScope | null>;
};

export type WorkflowRoutinesEnv = {
  Variables: { workflowRoutineScope: WorkflowRoutineRunScope };
};

export type CreateWorkflowRoutineRoutesDeps = {
  store: RoutineStore;
  launcher: RoutineLauncher;
  authenticator: WorkflowRunAuthenticator;
  /** Backs `GET /targets`. Callers wire this to `listRoutineTargets`
   * (./targets.ts) — the same function the human-session
   * `createRoutineTargetRoutes` calls — so Myra can resolve a requested
   * workflow name to its `definitionAssetId` before creating or
   * retargeting a routine. No second implementation of target
   * discovery; this is only where the run's tenant/principal meet it. */
  listTargets: (query: RoutineTargetsQuery) => Promise<RoutineTargetsPage>;
  /** Same contract as `CreateRoutineRoutesDeps.resolveTarget`. */
  resolveTarget?: LaunchableDefinitionResolver;
  /** Same contract as `CreateRoutineRoutesDeps.grantStore` /
   * `conditionRegistry` — both wired authorizes a create/retarget's
   * resolved target for Myra's own acting principal, same as the
   * tenant-session surface. */
  grantStore?: GrantStore;
  conditionRegistry?: ConditionRegistry;
  /** Same contract as `CreateRoutineRoutesDeps.webhookTriggerInTenant`. */
  webhookTriggerInTenant?: (
    tenantId: string,
    webhookTriggerId: string,
    definitionAssetId: string,
  ) => Promise<boolean>;
  /**
   * Resolves the creating run's own workbench — the workbench the person
   * was talking in when they asked for the routine. A routine created
   * with no `deliveryWorkbenchId` delivers there by default; there is no
   * further fallback — a routine's destination is always a workbench a
   * person is actually in or explicitly names, never one invented and
   * named after the routine.
   */
  resolveRunWorkbench?: (
    tenantId: string,
    runId: string,
  ) => Promise<string | undefined>;
  /** Same contract as `CreateRoutineRoutesDeps.deliveryWorkbenchRequired`. */
  deliveryWorkbenchRequired?: (
    tenantId: string,
    definitionAssetId: string,
  ) => Promise<boolean>;
  /** Same contract as `CreateRoutineRoutesDeps.validateRoutineInput`. */
  validateRoutineInput?: (
    tenantId: string,
    definitionAssetId: string,
    input: Record<string, unknown>,
  ) => Promise<
    { readonly ok: true } | { readonly ok: false; readonly message: string }
  >;
  /** Same contract as `CreateRoutineRoutesDeps.workbenchNotice`. */
  workbenchNotice?: WorkbenchNoticePort | undefined;
};

// `scope` is always `"bench"` — Myra always creates for the shared
// workbench, never a personal routine on someone else's behalf — so
// unlike `CreateRoutineBody` in `./routes.ts`, this body carries no
// `scope` field at all.
const CreateWorkflowRoutineBody = type({
  name: "string",
  definitionAssetId: "string > 0",
  trigger: RoutineTrigger,
  "input?": "Record<string, unknown>",
  "deliveryWorkbenchId?": "string",
  "runOnceNow?": "boolean",
});

const UpdateWorkflowRoutineBody = type({
  "enabled?": "boolean",
  "name?": "string",
  /** Retargets the routine at a different workflow asset (CL-7359,
   * CL-7353) — an explicit asset id, never a name search, same as
   * `create`'s `definitionAssetId`. */
  "definitionAssetId?": "string > 0",
  "trigger?": RoutineTrigger,
  "input?": "Record<string, unknown>",
});

const RunNowBody = type({
  "input?": "Record<string, unknown>",
});

export function createWorkflowRoutineRoutes(
  deps: CreateWorkflowRoutineRoutesDeps,
): Hono<WorkflowRoutinesEnv> {
  const app = new Hono<WorkflowRoutinesEnv>();

  app.use("*", async (c, next) => {
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : "";
    const address = c.req.header("x-workflow-run-address") ?? "";
    const scope = await deps.authenticator.resolve(token, address);
    if (scope === null) {
      return c.json(
        makeErrorEnvelope({
          code: "unauthorized",
          userMessage:
            "Missing or unrecognized sidecar bearer token / run address",
        }),
        401,
      );
    }
    c.set("workflowRoutineScope", scope);
    await next();
  });

  app.get("/targets", async (c) => {
    const scope = c.get("workflowRoutineScope");
    const rawLimit = c.req.query("limit");
    const limit =
      rawLimit === undefined
        ? ROUTINE_TARGETS_DEFAULT_LIMIT
        : TargetsLimitParam(rawLimit);
    if (limit instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `limit must be an integer between 1 and ${String(ROUTINE_TARGETS_MAX_LIMIT)}.`,
        }),
        400,
      );
    }
    const cursor = c.req.query("cursor");
    try {
      const page = await deps.listTargets({
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        limit,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      return c.json(page);
    } catch (error) {
      if (error instanceof InvalidRoutineTargetCursorError) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: error.message,
          }),
          400,
        );
      }
      throw error;
    }
  });

  app.get("/routines", async (c) => {
    const scope = c.get("workflowRoutineScope");
    const rows = await deps.store.listRoutines(scope.tenantId);
    const items = await Promise.all(
      rows.map((row) => resolvedRoutineView(deps, row)),
    );
    return c.json({ items });
  });

  app.post("/routines", async (c) => {
    const scope = c.get("workflowRoutineScope");
    const body = CreateWorkflowRoutineBody(
      await c.req.json().catch(() => undefined),
    );
    if (body instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `invalid routine body: ${body.summary}`,
        }),
        400,
      );
    }

    const definitionAssetId = body.definitionAssetId;
    const rejection = await rejectUnlaunchableTarget(
      deps,
      scope.tenantId,
      scope.principalId,
      definitionAssetId,
    );
    if (rejection !== undefined) {
      return c.json(
        makeErrorEnvelope({
          code: rejection.code,
          userMessage: rejection.userMessage,
        }),
        rejection.status,
      );
    }

    if (
      !(await webhookTriggerValid(
        deps,
        scope.tenantId,
        body.trigger,
        definitionAssetId,
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

    // Delivery target precedence: the workbench the caller named, then
    // the creating run's own workbench (a routine asked for inside a
    // workbench reports back into that workbench). Nothing is ever
    // auto-provisioned — a routine's destination is always a workbench a
    // person picked or was actually in, never one invented and named
    // after the routine.
    const namedWorkbenchId =
      body.deliveryWorkbenchId !== undefined && body.deliveryWorkbenchId !== ""
        ? body.deliveryWorkbenchId
        : undefined;
    const deliveryRequired = await isDeliveryWorkbenchRequired(
      deps,
      scope.tenantId,
      definitionAssetId,
    );

    const homeWorkbenchId =
      deliveryRequired && namedWorkbenchId === undefined
        ? await deps.resolveRunWorkbench?.(scope.tenantId, scope.runId)
        : undefined;

    const needsDelivery =
      deliveryRequired &&
      namedWorkbenchId === undefined &&
      homeWorkbenchId === undefined;

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
        scope.tenantId,
        definitionAssetId,
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

    const deliveryWorkbenchId = namedWorkbenchId ?? homeWorkbenchId ?? null;

    const row = await deps.store.createRoutine({
      tenantId: scope.tenantId,
      name: body.name,
      definitionAssetId,
      trigger: body.trigger,
      scope: "bench",
      input: body.input ?? {},
      deliveryWorkbenchId,
      createdBy: scope.principalId,
    });

    if (body.runOnceNow === true) {
      await launchAndCorrelate(
        { store: deps.store, launcher: deps.launcher },
        {
          tenantId: scope.tenantId,
          principalId: scope.principalId,
          definitionAssetId: row.definitionAssetId,
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
      { tenantId: scope.tenantId, principalId: scope.principalId, row },
    );

    if (row.enabled) {
      await postRoutineEnabledNotice(deps, {
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        workbenchId: row.deliveryWorkbenchId,
        name: row.name,
        trigger: row.trigger,
        verb: "Created",
      });
    }

    return c.json(await resolvedRoutineView(deps, row), 201);
  });

  app.patch("/routines/:id", async (c) => {
    const scope = c.get("workflowRoutineScope");
    const body = UpdateWorkflowRoutineBody(
      await c.req.json().catch(() => undefined),
    );
    if (body instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `invalid routine patch: ${body.summary}`,
        }),
        400,
      );
    }

    const routineId = c.req.param("id");
    const existing = await deps.store.getRoutine(scope.tenantId, routineId);
    if (existing === undefined) {
      return c.json(
        makeErrorEnvelope({
          code: "not_found",
          userMessage: "routine not found",
        }),
        404,
      );
    }

    if (body.definitionAssetId !== undefined) {
      const rejection = await rejectUnlaunchableTarget(
        deps,
        scope.tenantId,
        scope.principalId,
        body.definitionAssetId,
      );
      if (rejection !== undefined) {
        return c.json(
          makeErrorEnvelope({
            code: rejection.code,
            userMessage: rejection.userMessage,
          }),
          rejection.status,
        );
      }
    }

    const effectiveDefinitionAssetId =
      body.definitionAssetId ?? existing.definitionAssetId;

    if (
      body.definitionAssetId !== undefined &&
      body.definitionAssetId !== existing.definitionAssetId
    ) {
      const rejection = await rejectUnlaunchableTarget(
        deps,
        scope.tenantId,
        scope.principalId,
        body.definitionAssetId,
      );
      if (rejection !== undefined) {
        return c.json(
          makeErrorEnvelope({
            code: rejection.code,
            userMessage: rejection.userMessage,
          }),
          rejection.status,
        );
      }
    }

    if (
      body.trigger !== undefined &&
      !(await webhookTriggerValid(
        deps,
        scope.tenantId,
        body.trigger,
        effectiveDefinitionAssetId,
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

    // A retarget onto a different definition can leave a routine that
    // fails at next launch unless the same checks `POST /routines` runs
    // for these fields are re-run against the new target — see
    // `./routine-operations.ts`'s `validateRetarget`, shared with
    // `./routes.ts`'s own PATCH handler so this can't drift a second time.
    if (body.definitionAssetId !== undefined) {
      const retargetRejection = await validateRetarget(
        deps,
        scope.tenantId,
        effectiveDefinitionAssetId,
        existing,
      );
      if (retargetRejection !== undefined) {
        return c.json(
          makeErrorEnvelope({
            code: retargetRejection.code,
            userMessage: retargetRejection.userMessage,
          }),
          400,
        );
      }
    }

    let patch: UpdateRoutineInput = {};
    if (body.name !== undefined) patch = { ...patch, name: body.name };
    if (body.definitionAssetId !== undefined) {
      patch = { ...patch, definitionAssetId: body.definitionAssetId };
    }
    if (body.trigger !== undefined) patch = { ...patch, trigger: body.trigger };
    if (body.input !== undefined) patch = { ...patch, input: body.input };
    if (body.enabled !== undefined) patch = { ...patch, enabled: body.enabled };

    const row = await deps.store.updateRoutine(
      scope.tenantId,
      routineId,
      patch,
    );

    const isEnableFlip = body.enabled === true && !existing.enabled;
    if (isEnableFlip) {
      await postRoutineEnabledNotice(deps, {
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        workbenchId: row.deliveryWorkbenchId,
        name: row.name,
        trigger: row.trigger,
        verb: "Enabled",
      });
    }

    return c.json(await resolvedRoutineView(deps, row));
  });

  app.post("/routines/:id/run", async (c) => {
    const scope = c.get("workflowRoutineScope");
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

    const routineId = c.req.param("id");
    const existing = await deps.store.getRoutine(scope.tenantId, routineId);
    if (existing === undefined) {
      return c.json(
        makeErrorEnvelope({
          code: "not_found",
          userMessage: "routine not found",
        }),
        404,
      );
    }

    // "Run now" is an unscheduled fire of the exact launcher a scheduled
    // trigger would call — see `launchAndCorrelate`'s own doc comment;
    // never a second launch code path for Myra's own surface either.
    if (
      (await isDeliveryWorkbenchRequired(
        deps,
        scope.tenantId,
        existing.definitionAssetId,
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
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        definitionAssetId: existing.definitionAssetId,
        input: body.input ?? existing.input,
        routineId,
        triggeredBy: "manual",
        deliveryWorkbenchId: existing.deliveryWorkbenchId,
        routineName: existing.name,
      },
    );

    return c.json({ runId: launched.runId }, 201);
  });

  return app;
}
