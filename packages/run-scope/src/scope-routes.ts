// The workbench-owned answer to "which of this tenant's workflow runs
// are genuine top-level deployments?" — the question
// `packages/chat-ui/src/folded-run-ids.ts` used to answer by deriving
// an exclusion set from a tenant's *workbenches*. This route answers
// it server-side instead, straight off `workflow_run`.
//
// The listing predicate mirrors vendor's own "top-level run" predicate
// (`isNotNull(workflowRun.address)`, `anchorRunId === id`) — see
// `vendor/intx/hub-api/src/routes/runs.ts`'s `GET /workflows/runs` and
// `vendor/intx/hub-sessions/src/hub-session-lookups.ts`'s
// `isTopLevelRun`, this route's reference implementation.
//
// A second feed lives here too (`feed=fires`, `listTopLevelRunFires`,
// CL-6249): Insights' different question, "which runs actually executed"
// rather than "which deployments exist." A deployment's anchor row that
// never got triggered is not a run at all (it stays `status: "deployed"`
// forever — see `listTopLevelRunFires`'s own comment), so that feed drops
// it. `resolveRoutineFires` annotates a fire with its parent schedule
// when the host wires the port; it is not an exception to the listing
// predicate.
import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { Hono } from "hono";
import { type } from "arktype";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import { getDescendantTenants, type DB } from "@intx/db";
import { workflowDefinition, workflowRun } from "@intx/db/schema";
import type { WorkflowRunStatus } from "@intx/types";
import { makeErrorEnvelope } from "@corbits/error-sink";
import { listingTurnsByRunId } from "./in-flight-turns";

/** A routine fire's parent, resolved by `resolveRoutineFires` below. */
export type RoutineFireInfo = {
  readonly routineId: string;
  readonly routineName: string;
};

/**
 * Host-supplied port: given a batch of run ids, returns the subset that
 * are scheduled fires, each with its parent schedule's id and human
 * name. Optional: a host that mounts this route without wiring it
 * still lists fires; those rows simply report no schedule parent.
 */
export type ResolveRoutineFires = (
  runIds: readonly string[],
) => Promise<ReadonlyMap<string, RoutineFireInfo>>;

export type CreateTopLevelRunRoutesDeps = {
  db: DB["db"];
  requireGrant: RequireGrant;
  resolveRoutineFires?: ResolveRoutineFires;
};

// A positive integer parsed straight out of the raw query string —
// arktype's own `string.integer.parse` morph (validate-then-coerce in
// one step, matching how `c.req.query()` bodies are parsed elsewhere
// in this codebase, e.g. `@corbits/insights`' `RangeQuery` in its
// routes.ts) rather than a hand-rolled `Number()`/`Number.isInteger`
// check. `> 0` cannot chain directly onto a morph in arktype's string
// syntax, hence the `.narrow` — the fluent equivalent of the same
// bound.
const PositiveInteger = type("string.integer.parse").narrow((n) => n > 0);
const LimitQuery = type({
  "limit?": PositiveInteger,
});

// `feed=fires` opts into `listTopLevelRunFires` (Insights' executed-runs
// question); omitted (the default) keeps `listTopLevelRuns` unchanged for
// its existing callers — the Agent Directory and the shell's activity
// bands, which need every deployment, fired or not.
const FeedQuery = type({
  "feed?": "'fires'",
});

// Mirrors `vendor/intx/hub-api/src/routes/run-view.ts`'s
// `mapRunStatusToViewStatus` (not published from `@intx/hub-api`, so
// this is the small, stable slice of it this route's wire shape
// needs) — a run's raw `workflow_run.status` mapped onto the same
// `WorkflowRunResponse` status vocabulary every other run-listing
// surface already speaks.
function toViewStatus(status: string): WorkflowRunStatus {
  switch (status) {
    case "deployed":
      return "deployed";
    case "running":
      return "running";
    case "completed":
    case "cancelled":
      return "stopped";
    case "failed":
      return "error";
    default:
      throw new Error(`unmapped workflow_run status "${status}"`);
  }
}

function toTimestamp(date: Date): string {
  return date.toISOString();
}

/**
 * The tenant's (or tenant subtree's) genuine top-level deployment runs,
 * most recent first — the query `createTopLevelRunRoutes` serves.
 * Exported separately from the route so a non-HTTP caller (a future
 * scoped listing elsewhere in the hub) can reuse the same predicate
 * without going through Hono.
 *
 * `tenantId` also accepts an array — the same shape
 * `@corbits/insights`' `resolveScope` (packages/insights/src/routes.ts)
 * passes to `summarizeUsage`/`activityByDay`, so a workspace parent's
 * runs feed rolls up its child workbenches' runs the same way its
 * usage/activity numbers already do. A lone string keeps every existing
 * single-tenant caller unchanged.
 */
export async function listTopLevelRuns(
  db: DB["db"],
  tenantId: string | readonly string[],
  limit = 100,
) {
  const scope = typeof tenantId === "string" ? [tenantId] : tenantId;
  if (scope.length === 0) return [];
  const rows = await db
    .select({
      id: workflowRun.id,
      definitionId: workflowRun.definitionId,
      definitionName: workflowDefinition.name,
      tenantId: workflowRun.tenantId,
      address: workflowRun.address,
      status: workflowRun.status,
      publicKey: workflowRun.publicKey,
      kernelId: workflowRun.kernelId,
      sidecarId: workflowRun.sidecarId,
      createdAt: workflowRun.createdAt,
      endedAt: workflowRun.endedAt,
    })
    .from(workflowRun)
    .innerJoin(
      workflowDefinition,
      eq(workflowRun.definitionId, workflowDefinition.id),
    )
    .where(
      and(
        inArray(workflowRun.tenantId, scope),
        isNotNull(workflowRun.address),
        eq(workflowRun.anchorRunId, workflowRun.id),
      ),
    )
    .orderBy(desc(workflowRun.createdAt), desc(workflowRun.id))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    definitionId: row.definitionId,
    definitionName: row.definitionName,
    tenantId: row.tenantId,
    // Guarded by `isNotNull(workflowRun.address)` above.
    address: row.address as string,
    status: toViewStatus(row.status),
    publicKey: row.publicKey,
    kernelId: row.kernelId,
    sidecarId: row.sidecarId,
    createdAt: toTimestamp(row.createdAt),
    updatedAt: toTimestamp(row.endedAt ?? row.createdAt),
    endedAt: row.endedAt ? toTimestamp(row.endedAt) : null,
  }));
}

/**
 * Insights' `fires` feed (CL-6249): the tenant's genuine *executed*
 * runs, as opposed to `listTopLevelRuns`' "every deployment, fired or
 * not" — the Agent Directory's question. A run's own `status` already
 * says which one it is: `workflow_run.status` is born "deployed" only
 * for a deployment's anchor row and never changes back to it once a
 * first trigger flips it to "running" (see `vendor/intx/db`'s
 * `workflow-run.ts`). So `status <> 'deployed'` is exactly "this row
 * is not the resident, never-fired deployment placeholder" — no
 * slug/name heuristic needed.
 *
 * `resolveRoutineFires` (the host's scheduled-fire bridge) annotates
 * a listed row with its parent schedule's id/name when the host
 * recognizes it as a fire. A row the port does not claim, or a host
 * that never wires the port, still lists and reports no schedule
 * parent — the caller's honest "definition name" fallback.
 */
export async function listTopLevelRunFires(
  db: DB["db"],
  tenantId: string | readonly string[],
  resolveRoutineFires: ResolveRoutineFires | undefined,
  limit = 100,
) {
  const scope = typeof tenantId === "string" ? [tenantId] : tenantId;
  if (scope.length === 0) return [];
  const rows = await db
    .select({
      id: workflowRun.id,
      definitionId: workflowRun.definitionId,
      definitionName: workflowDefinition.name,
      tenantId: workflowRun.tenantId,
      address: workflowRun.address,
      status: workflowRun.status,
      publicKey: workflowRun.publicKey,
      kernelId: workflowRun.kernelId,
      sidecarId: workflowRun.sidecarId,
      createdAt: workflowRun.createdAt,
      endedAt: workflowRun.endedAt,
    })
    .from(workflowRun)
    .innerJoin(
      workflowDefinition,
      eq(workflowRun.definitionId, workflowDefinition.id),
    )
    .where(
      and(
        inArray(workflowRun.tenantId, scope),
        isNotNull(workflowRun.address),
        eq(workflowRun.anchorRunId, workflowRun.id),
        ne(workflowRun.status, "deployed"),
      ),
    )
    .orderBy(desc(workflowRun.createdAt), desc(workflowRun.id))
    .limit(limit);

  const runIds = rows.map((row) => row.id);
  const routineFires =
    runIds.length > 0 && resolveRoutineFires !== undefined
      ? await resolveRoutineFires(runIds)
      : new Map<string, RoutineFireInfo>();

  const turnsByRun = await listingTurnsByRunId(db, runIds);

  return rows.map((row) => {
    const fire = routineFires.get(row.id);
    const turns = turnsByRun.get(row.id) ?? [];
    return {
      id: row.id,
      definitionId: row.definitionId,
      definitionName: row.definitionName,
      tenantId: row.tenantId,
      // Guarded by `isNotNull(workflowRun.address)` above.
      address: row.address as string,
      status: toViewStatus(row.status),
      publicKey: row.publicKey,
      kernelId: row.kernelId,
      sidecarId: row.sidecarId,
      createdAt: toTimestamp(row.createdAt),
      updatedAt: toTimestamp(row.endedAt ?? row.createdAt),
      endedAt: row.endedAt ? toTimestamp(row.endedAt) : null,
      routineId: fire?.routineId ?? null,
      routineName: fire?.routineName ?? null,
      hasInFlightTurn: turns.length > 0,
      turns,
    };
  });
}

/**
 * Mounted at `${TENANT_PREFIX}/top-level-runs` in the hub composition
 * root, beside every other package-owned tenant route. `GET /` is the
 * one route: a paginated-shaped (but not yet cursor-paginated — see
 * the "known limit" note on every caller of this route) list of the
 * tenant's genuine top-level runs — rolled up over the requested
 * tenant's whole descendant subtree the same way
 * `@corbits/insights`' `/usage`, `/activity`, and `/tools` already do
 * (see `resolveScope` in packages/insights/src/routes.ts), so a
 * workspace parent's runs feed is never mismatched against its own
 * usage aggregate.
 */
export function createTopLevelRunRoutes(
  deps: CreateTopLevelRunRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.get("/", deps.requireGrant("workflow-run:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const rawLimit = c.req.query("limit");
    const query = LimitQuery(rawLimit === undefined ? {} : { limit: rawLimit });
    if (query instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: query.summary,
        }),
        400,
      );
    }
    const rawFeed = c.req.query("feed");
    const feedQuery = FeedQuery(rawFeed === undefined ? {} : { feed: rawFeed });
    if (feedQuery instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: feedQuery.summary,
        }),
        400,
      );
    }
    const scope = await getDescendantTenants(deps.db, tenant.id);
    const data =
      feedQuery.feed === "fires"
        ? await listTopLevelRunFires(
            deps.db,
            scope,
            deps.resolveRoutineFires,
            query.limit,
          )
        : await listTopLevelRuns(deps.db, scope, query.limit);
    return c.json({ data, nextCursor: null });
  });

  return app;
}
