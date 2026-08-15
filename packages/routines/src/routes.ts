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

import { RoutineTrigger, type RoutineTriggerT } from "./trigger";
import type { RoutineRow, RoutineRunRow, RoutineStore } from "./store";

export interface LaunchedRoutineRun {
  readonly runId: string;
  readonly deliveryThreadId?: string;
}

/**
 * The launcher port: routines never launch a run themselves — they
 * hand the definition/input off to whatever launches folded runs on
 * the host (`@corbits/folded-runs` in this repo), then record the
 * correlation. Keeping this a port, not a direct dependency, is what
 * keeps `@corbits/routines` hosted-service-agnostic.
 *
 * When `deliveryChannelId` is set, the host must post results into that
 * channel's delivery thread (`deliveryThreadId` when provided).
 */
export interface RoutineLauncher {
  launchRoutineRun(input: {
    tenantId: string;
    principalId: string;
    definitionId: string;
    input: Record<string, unknown>;
    deliveryChannelId?: string | null | undefined;
    deliveryThreadId?: string | null | undefined;
    runRef?: string | undefined;
  }): Promise<LaunchedRoutineRun>;
}

/**
 * Optional port: open a delivery thread in the routine's channel before
 * launch. Wired to `@corbits/chat` `createDeliveryThread` at the hub.
 */
export interface DeliveryThreadPort {
  createDeliveryThread(input: {
    tenantId: string;
    channelId: string;
    runRef: string;
    title?: string;
  }): Promise<{ id: string }>;
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
   * Delivery-thread creation for the delivery invariant. When set,
   * every fire with a `deliveryChannelId` opens (or reuses) a delivery
   * thread before launch.
   */
  deliveryThreads?: DeliveryThreadPort | undefined;
  /**
   * Whether a routine on this definition must carry a `deliveryChannelId`
   * — `false` for a workflow whose result never posts to a channel at
   * all (e.g. the recurring-task bridge, which always delivers to its
   * creator's Inbox). Omitted defaults every definition to
   * channel-required, the behavior before this port existed — a host
   * that never wires it keeps every prior create/run-now/fire contract
   * unchanged. Consulted at create, at "run now", and at every
   * scheduled fire (`fireScheduledRoutine`'s own `deps` takes the same
   * port), so a routine can never end up silently missing the delivery
   * its own workflow actually needs, and never forced to collect a
   * channel a workflow would just discard.
   */
  deliveryChannelRequired?: (
    tenantId: string,
    definitionId: string,
  ) => Promise<boolean>;
  /**
   * Validates `input` against the definition's own declared
   * trigger-field contract (shape — every required field a non-empty
   * string — and, for an `"agent"`-kind field, that the value actually
   * resolves to a real taskable definition) before a routine is
   * created. This is the friendly, early rejection; the workflow's own
   * fire-time validation (a host's launcher, e.g. `launchTask`'s
   * definition checks) is the authoritative second line — omitting
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
};

const ErrorEnvelope = (code: string, message: string) => ({
  error: { code, message },
});

const CreateRoutineBody = type({
  name: "string",
  definitionId: "string",
  trigger: RoutineTrigger,
  scope: "'personal' | 'bench'",
  "input?": "Record<string, unknown>",
  // Whether this is actually required depends on the definition's own
  // delivery mode (see `deliveryChannelRequired`, checked below, after
  // parse) — a workflow that only ever delivers to its creator's Inbox
  // must never be forced to collect a channel it would just discard.
  "deliveryChannelId?": "string",
  "runOnceNow?": "boolean",
});

const UpdateRoutineBody = type({
  "name?": "string",
  "trigger?": RoutineTrigger,
  "input?": "Record<string, unknown>",
  "enabled?": "boolean",
  "deliveryChannelId?": "string",
});

const RunNowBody = type({
  "input?": "Record<string, unknown>",
});

const CreateDraftBody = type({
  prompt: "string",
  deliveryChannelId: "string",
  scope: "'personal' | 'bench'",
});

/**
 * The wire shape for a routine — never a raw id-only reference, always
 * the name and structured trigger a UI can render directly, per the
 * platform's "no raw IDs on screen" floor.
 */
function routineView(row: RoutineRow) {
  return {
    id: row.id,
    name: row.name,
    definitionId: row.definitionId,
    trigger: row.trigger,
    scope: row.scope,
    input: row.input,
    enabled: row.enabled,
    deliveryChannelId: row.deliveryChannelId,
    consecutiveFailures: row.consecutiveFailures,
    deadLetteredAt: row.deadLetteredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function runView(
  row: RoutineRunRow,
  resolver: RunSummaryResolver | undefined,
) {
  const summary = await resolver?.resolveRunSummary(row.tenantId, row.runId);
  return {
    runId: row.runId,
    triggeredBy: row.triggeredBy,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    ...(summary !== undefined ? { run: summary } : {}),
  };
}

/**
 * Launch then correlate. If the correlation write fails after a
 * successful launch, rethrow loudly with the run id in the message —
 * never silently orphan a platform run. Clears fire-failure counters
 * only after both steps succeed.
 *
 * When the routine has a delivery channel and a deliveryThreads port is
 * wired, opens a delivery thread first and passes it to the launcher.
 */
async function launchAndCorrelate(
  deps: {
    store: RoutineStore;
    launcher: RoutineLauncher;
    deliveryThreads?: DeliveryThreadPort | undefined;
  },
  input: {
    tenantId: string;
    principalId: string;
    definitionId: string;
    input: Record<string, unknown>;
    routineId: string;
    triggeredBy: string;
    deliveryChannelId: string | null;
    routineName?: string;
  },
): Promise<LaunchedRoutineRun> {
  let deliveryThreadId: string | undefined;
  if (
    input.deliveryChannelId !== null &&
    input.deliveryChannelId !== "" &&
    deps.deliveryThreads !== undefined
  ) {
    // runRef is stable per fire attempt: routine id + triggeredBy + time bucket
    const runRef = `${input.routineId}:${input.triggeredBy}:${Date.now()}`;
    const thread = await deps.deliveryThreads.createDeliveryThread({
      tenantId: input.tenantId,
      channelId: input.deliveryChannelId,
      runRef,
      ...(input.routineName !== undefined ? { title: input.routineName } : {}),
    });
    deliveryThreadId = thread.id;
  }

  const launched = await deps.launcher.launchRoutineRun({
    tenantId: input.tenantId,
    principalId: input.principalId,
    definitionId: input.definitionId,
    input: input.input,
    deliveryChannelId: input.deliveryChannelId,
    deliveryThreadId: deliveryThreadId !== undefined ? deliveryThreadId : null,
    runRef: deliveryThreadId !== undefined ? input.routineId : undefined,
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
  return {
    runId: launched.runId,
    ...(deliveryThreadId !== undefined ? { deliveryThreadId } : {}),
  };
}

/**
 * `true` when `trigger` is not a webhook binding (nothing to check), or
 * when it is and the referenced webhook-triggers row checks out for this
 * tenant and definition. See `webhookTriggerInTenant`'s doc comment on
 * why the definition id must match.
 */
async function webhookTriggerValid(
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

/** Every definition defaults to channel-required — see
 * `CreateRoutineRoutesDeps.deliveryChannelRequired`'s own doc comment
 * for why an omitted port must never change prior behavior. */
async function isDeliveryChannelRequired(
  deps: Pick<CreateRoutineRoutesDeps, "deliveryChannelRequired">,
  tenantId: string,
  definitionId: string,
): Promise<boolean> {
  if (deps.deliveryChannelRequired === undefined) return true;
  return deps.deliveryChannelRequired(tenantId, definitionId);
}

export function createRoutineRoutes(
  deps: CreateRoutineRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.post(
    "/routines",
    deps.requireGrant("workflow-run:*", "create"),
    async (c) => {
      const body = CreateRoutineBody(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          ErrorEnvelope("bad_request", `invalid routine body: ${body.summary}`),
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
            ErrorEnvelope("not_found", "definition not found"),
            404,
          );
        }
      }

      if (
        !(await webhookTriggerValid(
          deps,
          tenant.id,
          body.trigger as RoutineTriggerT,
          body.definitionId,
        ))
      ) {
        return c.json(
          ErrorEnvelope("not_found", "webhook trigger not found"),
          404,
        );
      }

      if (
        (await isDeliveryChannelRequired(deps, tenant.id, body.definitionId)) &&
        (body.deliveryChannelId === undefined || body.deliveryChannelId === "")
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
          tenant.id,
          body.definitionId,
          body.input ?? {},
        );
        if (!validated.ok) {
          return c.json(ErrorEnvelope("bad_request", validated.message), 400);
        }
      }

      const row = await deps.store.createRoutine({
        tenantId: tenant.id,
        name: body.name,
        definitionId: body.definitionId,
        trigger: body.trigger as RoutineTriggerT,
        scope: body.scope,
        input: body.input ?? {},
        deliveryChannelId: body.deliveryChannelId ?? null,
        createdBy: principal.id,
      });

      if (body.runOnceNow === true) {
        await launchAndCorrelate(
          {
            store: deps.store,
            launcher: deps.launcher,
            deliveryThreads: deps.deliveryThreads,
          },
          {
            tenantId: tenant.id,
            principalId: principal.id,
            definitionId: row.definitionId,
            input: row.input,
            routineId: row.id,
            triggeredBy: "manual",
            deliveryChannelId: row.deliveryChannelId,
            routineName: row.name,
          },
        );
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
        return c.json(ErrorEnvelope("not_found", "routine not found"), 404);
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
          ErrorEnvelope(
            "bad_request",
            `invalid routine patch: ${body.summary}`,
          ),
          400,
        );
      }

      const tenant = c.get("tenant");
      const routineId = c.req.param("id");
      const existing = await deps.store.getRoutine(tenant.id, routineId);
      if (existing === undefined) {
        return c.json(ErrorEnvelope("not_found", "routine not found"), 404);
      }

      if (
        body.trigger !== undefined &&
        !(await webhookTriggerValid(
          deps,
          tenant.id,
          body.trigger as RoutineTriggerT,
          existing.definitionId,
        ))
      ) {
        return c.json(
          ErrorEnvelope("not_found", "webhook trigger not found"),
          404,
        );
      }

      const row = await deps.store.updateRoutine(tenant.id, routineId, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.trigger !== undefined
          ? { trigger: body.trigger as RoutineTriggerT }
          : {}),
        ...(body.input !== undefined ? { input: body.input } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.deliveryChannelId !== undefined
          ? { deliveryChannelId: body.deliveryChannelId }
          : {}),
      });

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
        return c.json(ErrorEnvelope("not_found", "routine not found"), 404);
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
        return c.json(ErrorEnvelope("not_found", "routine not found"), 404);
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
          ErrorEnvelope("bad_request", `invalid run body: ${body.summary}`),
          400,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const routineId = c.req.param("id");
      const existing = await deps.store.getRoutine(tenant.id, routineId);
      if (existing === undefined) {
        return c.json(ErrorEnvelope("not_found", "routine not found"), 404);
      }

      // "Run now" is an unscheduled fire of the exact launcher a
      // scheduled trigger would call — the only difference is
      // `triggeredBy`, never a second launch code path.
      if (
        (await isDeliveryChannelRequired(
          deps,
          tenant.id,
          existing.definitionId,
        )) &&
        (existing.deliveryChannelId === null ||
          existing.deliveryChannelId === "")
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
        {
          store: deps.store,
          launcher: deps.launcher,
          deliveryThreads: deps.deliveryThreads,
        },
        {
          tenantId: tenant.id,
          principalId: principal.id,
          definitionId: existing.definitionId,
          input: body.input ?? existing.input,
          routineId,
          triggeredBy: "manual",
          deliveryChannelId: existing.deliveryChannelId,
          routineName: existing.name,
        },
      );

      return c.json(
        {
          runId: launched.runId,
          ...(launched.deliveryThreadId !== undefined
            ? { deliveryThreadId: launched.deliveryThreadId }
            : {}),
        },
        201,
      );
    },
  );

  // --- Describe-to-agent drafting (path b) ---

  app.post(
    "/routine-drafts",
    deps.requireGrant("workflow-run:*", "create"),
    async (c) => {
      if (deps.drafts === undefined) {
        return c.json(ErrorEnvelope("not_found", "drafts not available"), 404);
      }
      const body = CreateDraftBody(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          ErrorEnvelope("bad_request", `invalid draft body: ${body.summary}`),
          400,
        );
      }
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const draft = await deps.drafts.createDraft({
        tenantId: tenant.id,
        prompt: body.prompt,
        deliveryChannelId: body.deliveryChannelId,
        scope: body.scope,
        createdBy: principal.id,
      });

      if (deps.drafting !== undefined) {
        const proposal = await deps.drafting.propose({
          tenantId: tenant.id,
          principalId: principal.id,
          prompt: body.prompt,
        });
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
        return c.json(ErrorEnvelope("not_found", "draft not found"), 404);
      }
      const tenant = c.get("tenant");
      const draft = await deps.drafts.getDraft(tenant.id, c.req.param("id"));
      if (draft === undefined) {
        return c.json(ErrorEnvelope("not_found", "draft not found"), 404);
      }
      return c.json(draftView(draft));
    },
  );

  app.post(
    "/routine-drafts/:id/approve",
    deps.requireGrant(idResource("workflow-run", "id"), "create"),
    async (c) => {
      if (deps.drafts === undefined) {
        return c.json(ErrorEnvelope("not_found", "draft not found"), 404);
      }
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const draftId = c.req.param("id");
      const draft = await deps.drafts.getDraft(tenant.id, draftId);
      if (draft === undefined) {
        return c.json(ErrorEnvelope("not_found", "draft not found"), 404);
      }
      if (draft.status !== "reviewed") {
        return c.json(
          ErrorEnvelope(
            "bad_request",
            `draft is ${draft.status}; only reviewed drafts can be approved`,
          ),
          400,
        );
      }
      if (draft.definitionId === null || draft.definitionId === "") {
        return c.json(
          ErrorEnvelope(
            "bad_request",
            "draft has no definitionId; review must pin a workflow definition",
          ),
          400,
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
        definitionId: draft.definitionId,
        trigger,
        scope: draft.scope,
        input: {
          draftedSteps: draft.proposedSteps,
          ...(draft.autonomy !== null ? { autonomy: draft.autonomy } : {}),
        },
        deliveryChannelId: draft.deliveryChannelId,
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
        return c.json(ErrorEnvelope("not_found", "draft not found"), 404);
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
          ErrorEnvelope(
            "bad_request",
            err instanceof Error ? err.message : "discard failed",
          ),
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
    deliveryChannelId: row.deliveryChannelId,
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
    deliveryThreads?: DeliveryThreadPort | undefined;
    deliveryChannelRequired?: (
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
    (await isDeliveryChannelRequired(
      deps,
      params.tenantId,
      params.routine.definitionId,
    )) &&
    (params.routine.deliveryChannelId === null ||
      params.routine.deliveryChannelId === "")
  ) {
    throw new Error(
      `routine ${params.routine.id} has no deliveryChannelId; cannot fire`,
    );
  }
  return launchAndCorrelate(deps, {
    tenantId: params.tenantId,
    principalId: params.routine.createdBy,
    definitionId: params.routine.definitionId,
    input: params.routine.input,
    routineId: params.routine.id,
    triggeredBy: "schedule",
    deliveryChannelId: params.routine.deliveryChannelId,
    routineName: params.routine.name,
  });
}
