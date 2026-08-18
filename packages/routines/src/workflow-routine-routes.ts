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
// Myra may create or manage a routine targeting any workflow definition
// in her tenant, not just her own. `POST /routines` therefore checks
// `definitionInTenant`, never a same-definition-as-caller check.
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
import type { RoutineRow, RoutineStore, UpdateRoutineInput } from "./store";
import {
  isDeliveryChannelRequired,
  launchAndCorrelate,
  postRoutineEnabledNotice,
  routineView,
  webhookTriggerValid,
  type ChannelNoticePort,
  type DeliverySpacePort,
  type RoutineLauncher,
} from "./routes";

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
  /**
   * When provided, `POST /routines` rejects with 404 if the definition
   * is not in the resolved run's own tenant. Tests may omit
   * (always-allow) — same contract as `CreateRoutineRoutesDeps`'s port
   * of the same name.
   */
  definitionInTenant?: (
    tenantId: string,
    definitionId: string,
  ) => Promise<boolean>;
  /**
   * Resolves a `definitionId` that isn't a raw `wfd_` id into one by
   * exact-matching it as a deployed workflow definition's NAME within
   * the tenant. Myra's `routine_create` tool receives a definition's
   * name from `list_agents`, not its id — this lets `POST /routines`
   * accept either. Returns `undefined` when the name doesn't match any
   * deployed definition, or matches more than one (ambiguous); either
   * way the request then falls through to `definitionInTenant`'s 404.
   * Tests may omit (name resolution disabled; `definitionId` must
   * already be a raw id).
   */
  resolveDefinitionId?: (
    tenantId: string,
    idOrName: string,
  ) => Promise<string | undefined>;
  /**
   * Lists up to 8 `name (wfd_id)` candidates for the tenant, surfaced
   * in the 404 body when a `definitionId` resolves to neither a known
   * id nor a known name, so the calling model can self-correct. Tests
   * may omit (no candidates listed).
   */
  listDefinitionCandidates?: (
    tenantId: string,
  ) => Promise<readonly { id: string; name: string }[]>;
  /** Same contract as `CreateRoutineRoutesDeps.webhookTriggerInTenant`. */
  webhookTriggerInTenant?: (
    tenantId: string,
    webhookTriggerId: string,
    definitionId: string,
  ) => Promise<boolean>;
  /**
   * Resolves the creating run's own channel — the workbench the person
   * was talking in when they asked for the routine. A routine created
   * with no `deliveryChannelId` delivers there by default; a brand-new
   * space (via `deliverySpace` below) is only ever minted for a run
   * with no home channel of its own.
   */
  resolveRunChannel?: (
    tenantId: string,
    runId: string,
  ) => Promise<string | undefined>;
  /**
   * Same contract as `CreateRoutineRoutesDeps.deliverySpace`: provisions
   * a brand-new space for a routine created with no `deliveryChannelId`
   * by a run that `resolveRunChannel` cannot place in a channel, named
   * after the routine.
   */
  deliverySpace?: DeliverySpacePort | undefined;
  /**
   * Resolves the tenant's domain, needed only for the `deliverySpace`
   * auto-provision fallback: `DeliverySpacePort.createDeliverySpace`
   * requires `tenantDomain`, which a workflow run's authenticated scope
   * never carries (`WorkflowRoutineRunScope` above deliberately matches
   * `WorkflowCapabilityRunScope`'s minimal `{tenantId, principalId,
   * runId}` shape). Omitted disables auto-provisioning even when
   * `deliverySpace` is wired — a routine needing delivery with no
   * channel named still 400s, exactly like a host that never wired
   * `deliverySpace` at all.
   */
  resolveTenantDomain?: (tenantId: string) => Promise<string>;
  /** Same contract as `CreateRoutineRoutesDeps.deliveryChannelRequired`. */
  deliveryChannelRequired?: (
    tenantId: string,
    definitionId: string,
  ) => Promise<boolean>;
  /** Same contract as `CreateRoutineRoutesDeps.validateRoutineInput`. */
  validateRoutineInput?: (
    tenantId: string,
    definitionId: string,
    input: Record<string, unknown>,
  ) => Promise<
    { readonly ok: true } | { readonly ok: false; readonly message: string }
  >;
  /** Same contract as `CreateRoutineRoutesDeps.channelNotice`. */
  channelNotice?: ChannelNoticePort | undefined;
};

const ErrorEnvelope = (code: string, message: string) => ({
  error: { code, message },
});

/** "definition not found" plus up to 8 `name (wfd_id)` candidates, so a
 * model that passed a bad id or name can self-correct. */
async function definitionNotFoundMessage(
  deps: CreateWorkflowRoutineRoutesDeps,
  tenantId: string,
): Promise<string> {
  if (deps.listDefinitionCandidates === undefined) {
    return "definition not found";
  }
  const candidates = await deps.listDefinitionCandidates(tenantId);
  if (candidates.length === 0) {
    return "definition not found";
  }
  const listed = candidates
    .slice(0, 8)
    .map((d) => `${d.name} (${d.id})`)
    .join(", ");
  return `definition not found. Valid definitions: ${listed}`;
}

// `scope` is always `"bench"` — Myra always creates for the shared
// workbench, never a personal routine on someone else's behalf — so
// unlike `CreateRoutineBody` in `./routes.ts`, this body carries no
// `scope` field at all.
const CreateWorkflowRoutineBody = type({
  name: "string",
  definitionId: "string",
  trigger: RoutineTrigger,
  "input?": "Record<string, unknown>",
  "deliveryChannelId?": "string",
  "runOnceNow?": "boolean",
});

const UpdateWorkflowRoutineBody = type({
  "enabled?": "boolean",
  "name?": "string",
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
        ErrorEnvelope(
          "unauthorized",
          "Missing or unrecognized sidecar bearer token / run address",
        ),
        401,
      );
    }
    c.set("workflowRoutineScope", scope);
    await next();
  });

  app.get("/routines", async (c) => {
    const scope = c.get("workflowRoutineScope");
    const rows = await deps.store.listRoutines(scope.tenantId);
    return c.json({ items: rows.map(routineView) });
  });

  app.post("/routines", async (c) => {
    const scope = c.get("workflowRoutineScope");
    const body = CreateWorkflowRoutineBody(
      await c.req.json().catch(() => undefined),
    );
    if (body instanceof type.errors) {
      return c.json(
        ErrorEnvelope("bad_request", `invalid routine body: ${body.summary}`),
        400,
      );
    }

    let definitionId = body.definitionId;
    if (deps.definitionInTenant !== undefined) {
      let owned = await deps.definitionInTenant(scope.tenantId, definitionId);
      if (!owned && deps.resolveDefinitionId !== undefined) {
        const resolved = await deps.resolveDefinitionId(
          scope.tenantId,
          body.definitionId,
        );
        if (resolved !== undefined) {
          definitionId = resolved;
          owned = await deps.definitionInTenant(scope.tenantId, definitionId);
        }
      }
      if (!owned) {
        return c.json(
          ErrorEnvelope(
            "not_found",
            await definitionNotFoundMessage(deps, scope.tenantId),
          ),
          404,
        );
      }
    }

    if (
      !(await webhookTriggerValid(
        deps,
        scope.tenantId,
        body.trigger,
        definitionId,
      ))
    ) {
      return c.json(
        ErrorEnvelope("not_found", "webhook trigger not found"),
        404,
      );
    }

    // Delivery target precedence: the channel the caller named, then
    // the creating run's own channel (a routine asked for inside a
    // workbench reports back into that workbench), then a freshly
    // provisioned space as the last resort.
    const namedChannelId =
      body.deliveryChannelId !== undefined && body.deliveryChannelId !== ""
        ? body.deliveryChannelId
        : undefined;
    const deliveryRequired = await isDeliveryChannelRequired(
      deps,
      scope.tenantId,
      definitionId,
    );

    const homeChannelId =
      deliveryRequired && namedChannelId === undefined
        ? await deps.resolveRunChannel?.(scope.tenantId, scope.runId)
        : undefined;

    const needsDelivery =
      deliveryRequired &&
      namedChannelId === undefined &&
      homeChannelId === undefined;

    if (
      needsDelivery &&
      (deps.deliverySpace === undefined ||
        deps.resolveTenantDomain === undefined)
    ) {
      return c.json(
        ErrorEnvelope(
          "bad_request",
          "deliveryChannelId is required for this workflow",
        ),
        400,
      );
    }

    if (deps.validateRoutineInput !== undefined) {
      const validated = await deps.validateRoutineInput(
        scope.tenantId,
        definitionId,
        body.input ?? {},
      );
      if (!validated.ok) {
        return c.json(ErrorEnvelope("bad_request", validated.message), 400);
      }
    }

    // The space is provisioned before the routine row, and compensated
    // (deleted) if the row then fails to write — the same mint-then-
    // compensate shape `./routes.ts`'s own `POST /routines` uses.
    let provisionedSpace:
      { channelId: string; compensate: () => Promise<void> } | undefined;
    if (
      needsDelivery &&
      deps.deliverySpace !== undefined &&
      deps.resolveTenantDomain !== undefined
    ) {
      const tenantDomain = await deps.resolveTenantDomain(scope.tenantId);
      provisionedSpace = await deps.deliverySpace.createDeliverySpace({
        tenantId: scope.tenantId,
        tenantDomain,
        creatorPrincipalId: scope.principalId,
        // A workflow-run principal has no separate "user" id the way a
        // human tenant-session principal's `refId` names the underlying
        // user — its own run IS the acting identity, mirroring the
        // `refId = runId` convention `vendor/intx/hub-api`'s own grant
        // materialization uses for a workflow-kind principal.
        creatorUserId: scope.runId,
        name: body.name,
      });
    }
    const deliveryChannelId =
      namedChannelId ?? homeChannelId ?? provisionedSpace?.channelId ?? null;

    let row: RoutineRow;
    try {
      row = await deps.store.createRoutine({
        tenantId: scope.tenantId,
        name: body.name,
        definitionId,
        trigger: body.trigger,
        scope: "bench",
        input: body.input ?? {},
        deliveryChannelId,
        createdBy: scope.principalId,
      });
    } catch (err) {
      if (provisionedSpace !== undefined) {
        try {
          await provisionedSpace.compensate();
        } catch {
          // Best-effort: an orphaned space now requires manual cleanup,
          // same fallback `./routes.ts`'s own compensation failure takes.
        }
      }
      throw err;
    }

    if (body.runOnceNow === true) {
      await launchAndCorrelate(
        { store: deps.store, launcher: deps.launcher },
        {
          tenantId: scope.tenantId,
          principalId: scope.principalId,
          definitionId: row.definitionId,
          input: row.input,
          routineId: row.id,
          triggeredBy: "manual",
          deliveryChannelId: row.deliveryChannelId,
          routineName: row.name,
        },
      );
    }

    if (row.enabled) {
      await postRoutineEnabledNotice(deps, {
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        channelId: row.deliveryChannelId,
        name: row.name,
        trigger: row.trigger,
        verb: "Created",
      });
    }

    return c.json(routineView(row), 201);
  });

  app.patch("/routines/:id", async (c) => {
    const scope = c.get("workflowRoutineScope");
    const body = UpdateWorkflowRoutineBody(
      await c.req.json().catch(() => undefined),
    );
    if (body instanceof type.errors) {
      return c.json(
        ErrorEnvelope("bad_request", `invalid routine patch: ${body.summary}`),
        400,
      );
    }

    const routineId = c.req.param("id");
    const existing = await deps.store.getRoutine(scope.tenantId, routineId);
    if (existing === undefined) {
      return c.json(ErrorEnvelope("not_found", "routine not found"), 404);
    }

    if (
      body.trigger !== undefined &&
      !(await webhookTriggerValid(
        deps,
        scope.tenantId,
        body.trigger,
        existing.definitionId,
      ))
    ) {
      return c.json(
        ErrorEnvelope("not_found", "webhook trigger not found"),
        404,
      );
    }

    let patch: UpdateRoutineInput = {};
    if (body.name !== undefined) patch = { ...patch, name: body.name };
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
        channelId: row.deliveryChannelId,
        name: row.name,
        trigger: row.trigger,
        verb: "Enabled",
      });
    }

    return c.json(routineView(row));
  });

  app.post("/routines/:id/run", async (c) => {
    const scope = c.get("workflowRoutineScope");
    const body = RunNowBody(await c.req.json().catch(() => ({})));
    if (body instanceof type.errors) {
      return c.json(
        ErrorEnvelope("bad_request", `invalid run body: ${body.summary}`),
        400,
      );
    }

    const routineId = c.req.param("id");
    const existing = await deps.store.getRoutine(scope.tenantId, routineId);
    if (existing === undefined) {
      return c.json(ErrorEnvelope("not_found", "routine not found"), 404);
    }

    // "Run now" is an unscheduled fire of the exact launcher a scheduled
    // trigger would call — see `launchAndCorrelate`'s own doc comment;
    // never a second launch code path for Myra's own surface either.
    if (
      (await isDeliveryChannelRequired(
        deps,
        scope.tenantId,
        existing.definitionId,
      )) &&
      (existing.deliveryChannelId === null || existing.deliveryChannelId === "")
    ) {
      return c.json(
        ErrorEnvelope(
          "bad_request",
          "routine has no deliveryChannelId; set one before running",
        ),
        400,
      );
    }

    const launched = await launchAndCorrelate(
      { store: deps.store, launcher: deps.launcher },
      {
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        definitionId: existing.definitionId,
        input: body.input ?? existing.input,
        routineId,
        triggeredBy: "manual",
        deliveryChannelId: existing.deliveryChannelId,
        routineName: existing.name,
      },
    );

    return c.json({ runId: launched.runId }, 201);
  });

  return app;
}
