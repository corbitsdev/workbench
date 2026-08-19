/**
 * Hub-side memory plane mount — composition root. `@corbits/memory` is the
 * domain: it already ships its own engine, its own HTTP routes
 * (`registerMemoryRoutes`), and its own capability facts
 * (`Memory.capabilities`). This module's only job is composing that
 * upstream library against this hub's own `db`, grant store, and condition
 * registry — resolving the one process-wide config (`./memory-config`),
 * building the real engine at boot, and mounting upstream's routes plus
 * the read-only status route (`./memory-status`) exactly once.
 *
 * Boot-time, not lazy: `MemoryConfig` is env-only now (CL-6289's simpler
 * design — see `memory-config.ts`), and env is known at process start, so
 * there is no reason to defer building the engine or running its
 * migrations to first use. This removes the migration-in-request-path and
 * replica-race concerns the old lazy plane existed to manage.
 *
 * Data scope is a second, independent axis from config: `@corbits/memory`'s
 * `CallerResolver` seam (`registerMemoryRoutes`'s `callerResolver` — see
 * `./account-tenant.ts`) remaps every
 * caller's tenant to their bench/account tenant before any route runs, so a
 * caller in a workbench and the same caller in the bench itself always
 * reach the same memory, and two different accounts never collide.
 *
 * `createMemory({ app })`/`registerMemoryRoutes` register HTTP routes as a
 * side effect and are not safe to call twice — `mountMemory` is the one
 * place that calls `registerMemoryRoutes`, once, at hub start.
 *
 * Boundary casts (`as never`) match Scout's `mountKnowledge`
 * (`packages/agent-dock/src/knowledge.ts`): `@corbits/memory` ships against
 * its own Hono/authz type copies, and Hono env + ConditionRegistry are
 * invariant across package roots — cast only at this mount boundary.
 */
import type { Context, Hono, MiddlewareHandler } from "hono";
import {
  createMemory as buildMemoryPlane,
  runMemoryMigrations,
  getDegradeMetricsSnapshot,
  registerMemoryRoutes,
  type CallerResolver,
  type Memory,
} from "@corbits/memory";
import { and, eq } from "drizzle-orm";
import type { ConditionRegistry, GrantStore } from "@intx/authz";
import type { TenantEnv } from "@intx/hub-api";
import type { DB } from "@intx/db";
import { principal } from "@intx/db/schema";
import { createRequireGrant } from "@intx/hub-api";
import { getLogger } from "@intx/log";
import {
  createRunWriteRateLimiter,
  readWorkflowRunCredentials,
  MAX_WORKFLOW_WRITE_TEXT_CHARS,
  MAX_WORKFLOW_WRITES_PER_RUN_PER_MINUTE,
  type ResolvedWorkflowRunScope,
  type RunWriteRateLimiter,
  type WorkflowRunAuthenticator,
} from "@corbits/artifacts-hub";

import {
  resolveAccountTenantId,
  OperatorTenantHasNoAccountScopeError,
} from "./account-tenant";
import { resolveMemoryConfig } from "./memory-config";
import {
  buildMemoryPlaneStatus,
  createMemoryStatusRoutes,
} from "./memory-status";
import type {
  MemoryCallerScope,
  MemoryPlaneStatus,
  MemoryUnscopedReason,
} from "./memory-status";

const log = getLogger(["hub", "memory-mount"]);

/**
 * Env `createAccountCallerResolver`'s workflow branch and
 * `createWorkflowAddGuardMiddleware` share: the guard (mounted only on
 * `/api/tenants/:tenantId/memory/add`) authenticates once and stashes the
 * resolved scope here so the resolver — which every mounted memory route
 * runs through, including `/add` — never re-authenticates the same
 * request. Absent on every other route, where the resolver authenticates
 * directly off the request headers.
 */
type WorkflowGuardEnv = {
  Variables: { resolvedWorkflowRunScope?: ResolvedWorkflowRunScope };
};

export type MountMemoryOptions<E extends object = object> = {
  /** Hub Hono app (routes register under tenant memory paths). */
  app: Hono<E>;
  db: DB["db"];
  /** `HubConfig.databaseUrl` (`apps/hub/src/config.ts`) — the hub's own
   * already-parsed `DATABASE_URL`, passed explicitly rather than re-read
   * from `process.env` here, so a host that resolves it differently (e.g.
   * a test harness) never diverges from what the rest of the hub uses. */
  databaseUrl: string;
  grantStore: GrantStore;
  conditionRegistry: ConditionRegistry;
  /** `config.operatorTenantId` (`OPERATOR_TENANT_ID`) — where the
   * account-tenant walk must stop (see `account-tenant.ts`). Undefined
   * when this deploy has no operator tenant, in which case every bench is
   * already the root of its own chain. */
  operatorTenantId?: string;
  /**
   * Authenticates a workflow-process child's sidecar bearer token + run
   * address (CL-6296) — `@corbits/artifacts-hub`'s
   * `createWorkflowRunAuthenticator({ db })`. When supplied,
   * `createAccountCallerResolver`'s workflow branch and the `/add`
   * rate-limit/payload-cap guard both activate; when absent (e.g. a test
   * that only exercises the browser/session path), every request is
   * resolved as a session caller exactly as before this ticket.
   */
  workflowRunAuthenticator?: WorkflowRunAuthenticator;
};

export type MemoryMountHandle = {
  readonly memory: Memory;
};

async function accountScopeFor(
  db: DB["db"],
  operatorTenantId: string | undefined,
  tenantId: string,
): Promise<{ tenantId: string } | null> {
  try {
    const accountTenantId = await resolveAccountTenantId({
      db,
      tenantId,
      ...(operatorTenantId !== undefined ? { operatorTenantId } : {}),
    });
    return { tenantId: accountTenantId };
  } catch (cause) {
    if (cause instanceof OperatorTenantHasNoAccountScopeError) {
      log.warn(
        `memory: ${cause.message} (tenant ${tenantId} is the operator tenant)`,
      );
      return null;
    }
    throw cause;
  }
}

/**
 * The org tenant's own principal for the user a workbench principal stands
 * for, found by the same `(tenantId, kind: "user", refId)` lookup
 * `createResolveTenant` uses to seat a caller in any tenancy
 * (`@intx/hub-api`'s `middleware/tenant.ts`). A principal is scoped to one
 * tenancy; the user behind it is the durable identity, so a person acting
 * in any workbench under an org is the same person in that org.
 *
 * `null` when they hold no principal there — a guest invited into a single
 * workbench, whose own parent tenancy is elsewhere. `./memory-status.ts`
 * turns that into an explained state on the Memory page.
 */
async function resolveOrgPrincipalId(
  db: DB["db"],
  orgTenantId: string,
  userRefId: string,
): Promise<string | null> {
  const row = await db.query.principal.findFirst({
    where: and(
      eq(principal.tenantId, orgTenantId),
      eq(principal.kind, "user"),
      eq(principal.refId, userRefId),
    ),
  });
  return row?.id ?? null;
}

type SessionScope =
  | { readonly ok: true; readonly tenantId: string; readonly principalId: string }
  | { readonly ok: false; readonly reason: MemoryUnscopedReason };

/**
 * The one rule for where a browser caller's memory lives and who they are
 * in it. `createAccountCallerResolver` collapses a failure to `null` (which
 * upstream turns into a 401); `createMemoryCallerScopeDescriber` reports the
 * same failure by name so the Memory page can explain it. Both read this,
 * so the page can never describe an access the data routes would refuse.
 */
async function resolveSessionScope(
  db: DB["db"],
  operatorTenantId: string | undefined,
  caller: { readonly kind: string; readonly refId: string },
  callerTenantId: string,
): Promise<SessionScope> {
  if (caller.kind !== "user") return { ok: false, reason: "not-a-person" };

  const scope = await accountScopeFor(db, operatorTenantId, callerTenantId);
  if (scope === null) return { ok: false, reason: "no-account-tenant" };

  const principalId = await resolveOrgPrincipalId(
    db,
    scope.tenantId,
    caller.refId,
  );
  if (principalId === null) return { ok: false, reason: "no-org-principal" };

  return { ok: true, tenantId: scope.tenantId, principalId };
}

/**
 * Reports whether the calling person has any memory under this org, for
 * `./memory-status.ts`'s read-only status route. A caller with no session
 * at all is `not-a-person`: the status route's own fail-closed guard has
 * already rejected that case before this runs, so it is unreachable in the
 * mounted host and exists only so this function is total.
 */
export function createMemoryCallerScopeDescriber(
  db: DB["db"],
  operatorTenantId: string | undefined,
): (c: Context<TenantEnv>) => Promise<MemoryCallerScope> {
  return async (c) => {
    const caller = c.get("principal");
    const tenant = c.get("tenant");
    if (!caller || !tenant) return { kind: "unscoped", reason: "not-a-person" };

    const scope = await resolveSessionScope(
      db,
      operatorTenantId,
      caller,
      tenant.id,
    );
    return scope.ok ? { kind: "scoped" } : { kind: "unscoped", reason: scope.reason };
  };
}

/**
 * Resolves a caller's own tenant up to its bench/account tenant, and seats
 * that as the scope `registerMemoryRoutes` sees — never the workbench
 * tenant a browser session happens to be viewing, and never a run's own
 * (usually workbench) tenant either.
 *
 * A human's principal is resolved along with the scope, not carried
 * through it. Their grants and role assignments live in the org tenant
 * alongside the memory itself, so authorization has to resolve where the
 * data lives; pairing the workbench principal they happen to be calling
 * with against the org tenant matches no grant row there and denies every
 * member. A run's principal is the exception and does ride through
 * unchanged — `launchFoldedRun` writes its grants directly onto it in the
 * org tenant, bounded by whoever invoked the run.
 *
 * Two branches, workflow-run first:
 *
 *   1. When `workflowRunAuthenticator` is supplied AND the request carries
 *      both a sidecar bearer token and the run-address header, identity
 *      comes from `WorkflowRunAuthenticator` (a workflow-process child has
 *      no browser session). A token that fails to resolve returns `null`
 *      here — never falls through to branch 2 — so a bad token can never
 *      silently become an anonymous browser attempt.
 *      `createWorkflowAddGuardMiddleware` below authenticates the SAME
 *      pair ahead of this resolver on `/add` (to apply the rate limit and
 *      payload cap) and stashes its result on the context; when present,
 *      this branch reuses it rather than authenticating twice.
 *   2. Otherwise, the existing session-based resolution: the host's
 *      tenant-session middleware's own `principal`/`tenant`.
 *
 * `OperatorTenantHasNoAccountScopeError` (the resolved tenant IS the
 * operator tenant — no account beneath it) is treated the same as "could
 * not authenticate": `null`, which `@corbits/memory`'s `resolveCaller`
 * turns into a 401. Any other failure (a genuine database fault) is left
 * to propagate, same as an unexpected failure anywhere else in this route
 * tree.
 */
export function createAccountCallerResolver(
  db: DB["db"],
  operatorTenantId: string | undefined,
  workflowRunAuthenticator?: WorkflowRunAuthenticator,
): CallerResolver {
  return async (c: Context<TenantEnv & WorkflowGuardEnv>) => {
    if (workflowRunAuthenticator !== undefined) {
      const stashed = c.get("resolvedWorkflowRunScope");
      const { token, address } = readWorkflowRunCredentials(c.req.raw.headers);
      if (stashed !== undefined || (token !== "" && address !== "")) {
        const runScope =
          stashed ?? (await workflowRunAuthenticator.resolve(token, address));
        if (runScope === null) return null;
        const scope = await accountScopeFor(
          db,
          operatorTenantId,
          runScope.tenantId,
        );
        if (scope === null) return null;
        return { tenantId: scope.tenantId, principalId: runScope.principalId };
      }
    }

    const caller = c.get("principal");
    const tenant = c.get("tenant");
    if (!caller || !tenant) return null;

    const scope = await resolveSessionScope(
      db,
      operatorTenantId,
      caller,
      tenant.id,
    );
    if (!scope.ok) return null;
    return { tenantId: scope.tenantId, principalId: scope.principalId };
  };
}

/**
 * Mounted only on `/api/tenants/:tenantId/memory/add`, ahead of
 * `registerMemoryRoutes`, so the two protections the deleted
 * `@corbits/memory-hub` package used to enforce — a per-run write-rate
 * limit and a per-note character cap — apply again. Upstream's own
 * `RouteDeps` has no seam for either (see `@corbits/memory`'s
 * `IMPLEMENTATION.md`), so this re-homes them as host middleware exactly
 * as its migration note instructs, sharing the same rate limiter and cap
 * constant `@corbits/artifacts-hub`'s workflow-artifacts surface uses
 * (`./workflow-write-limits.ts`) rather than a third hand-rolled copy.
 *
 * A request with no workflow bearer token / run-address pair (a browser
 * caller) passes straight through: today's behavior for a human is
 * preserved exactly, cap and limit included.
 *
 * A bad token 401s here, immediately — never falls through to
 * `next()`, so a browser session can never pick up where a rejected
 * workflow token left off. A good token's resolved scope is stashed on
 * the context so `createAccountCallerResolver` (which still runs
 * downstream, inside `registerMemoryRoutes`) reuses it instead of
 * authenticating the same request twice.
 */
export function createWorkflowAddGuardMiddleware(
  authenticator: WorkflowRunAuthenticator,
  rateLimiter: RunWriteRateLimiter = createRunWriteRateLimiter(),
): MiddlewareHandler<WorkflowGuardEnv> {
  return async (c, next) => {
    const { token, address } = readWorkflowRunCredentials(c.req.raw.headers);
    if (token === "" || address === "") {
      await next();
      return;
    }

    const scope = await authenticator.resolve(token, address);
    if (scope === null) {
      return c.json(
        {
          error: "Missing or unrecognized sidecar bearer token / run address",
        },
        401,
      );
    }

    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      // Malformed JSON: let `registerMemoryRoutes`'s own validator
      // produce the 400, rather than this middleware duplicating it.
    }
    const text = (body as { text?: unknown } | null)?.text;
    if (
      typeof text === "string" &&
      text.length > MAX_WORKFLOW_WRITE_TEXT_CHARS
    ) {
      return c.json(
        {
          error:
            `text is ${text.length} characters, over the ` +
            `${MAX_WORKFLOW_WRITE_TEXT_CHARS}-character limit — shorten it ` +
            "or split it into multiple memory entries and try again.",
        },
        413,
      );
    }

    if (!rateLimiter.allow(scope.runId)) {
      return c.json(
        {
          error:
            `too many memory writes for this run in the last minute ` +
            `(limit ${MAX_WORKFLOW_WRITES_PER_RUN_PER_MINUTE}/min) — wait ` +
            "a moment before adding more.",
        },
        429,
      );
    }

    c.set("resolvedWorkflowRunScope", scope);
    await next();
  };
}

export async function mountMemory<E extends object = object>(
  options: MountMemoryOptions<E>,
): Promise<MemoryMountHandle> {
  const resolution = resolveMemoryConfig({
    env: process.env,
    databaseUrl: options.databaseUrl,
  });
  await runMemoryMigrations(resolution.config.memory.databaseUrl, {
    ftsLanguage: resolution.config.memory.ftsLanguage,
  });
  const memory = buildMemoryPlane({
    config: resolution.config,
    grantStore: options.grantStore,
    conditionRegistry: options.conditionRegistry,
  });

  const grants = {
    grantStore: options.grantStore,
    conditionRegistry: options.conditionRegistry,
  };
  const requireGrant = createRequireGrant(grants);
  const callerResolver = createAccountCallerResolver(
    options.db,
    options.operatorTenantId,
    options.workflowRunAuthenticator,
  );

  // Mounted BEFORE `registerMemoryRoutes` below, on the exact same route
  // pattern its own `/add` handler registers: Hono runs middleware in
  // registration order, so this always authenticates (and, on success,
  // caps + rate-limits) a workflow write before `callerResolver` gets a
  // chance to re-authenticate it. A no-op for every other route and for
  // any request without a workflow bearer token / run-address pair.
  if (options.workflowRunAuthenticator !== undefined) {
    (options.app as unknown as Hono<WorkflowGuardEnv>).use(
      "/api/tenants/:tenantId/memory/add",
      createWorkflowAddGuardMiddleware(options.workflowRunAuthenticator),
    );
  }

  registerMemoryRoutes(options.app as never, {
    memory,
    requireGrant: requireGrant as never,
    grants: grants as never,
    callerResolver: callerResolver as never,
  });

  async function describeStatus(tenantId: string): Promise<MemoryPlaneStatus> {
    const accountTenantId = await resolveAccountTenantId({
      db: options.db,
      tenantId,
      ...(options.operatorTenantId !== undefined
        ? { operatorTenantId: options.operatorTenantId }
        : {}),
    });
    const degrade = getDegradeMetricsSnapshot(accountTenantId);
    return buildMemoryPlaneStatus(
      resolution.source,
      resolution.config,
      memory.capabilities,
      degrade,
    );
  }

  options.app.route(
    "/api/tenants/:tenantId/memory",
    createMemoryStatusRoutes({
      plane: { describeStatus },
      requireGrant: requireGrant as never,
      describeCaller: createMemoryCallerScopeDescriber(
        options.db,
        options.operatorTenantId,
      ),
    }) as never,
  );

  log.info(
    `Memory plane mounted at /api/tenants/:tenantId/memory/* (source: ${resolution.source})`,
  );
  return { memory };
}
