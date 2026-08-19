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
 * `packages/memory-hub/src/account-tenant.ts`) remaps every
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
import type { Context, Hono } from "hono";
import {
  createMemory as buildMemoryPlane,
  runMemoryMigrations,
  getDegradeMetricsSnapshot,
  registerMemoryRoutes,
  type CallerResolver,
  type Memory,
} from "@corbits/memory";
import {
  resolveAccountTenantId,
  OperatorTenantHasNoAccountScopeError,
} from "@corbits/memory-hub";
import type { ConditionRegistry, GrantStore } from "@intx/authz";
import type { TenantEnv } from "@intx/hub-api";
import type { DB } from "@intx/db";
import { createRequireGrant } from "@intx/hub-api";
import { getLogger } from "@intx/log";

import { resolveMemoryConfig } from "./memory-config";
import {
  buildMemoryPlaneStatus,
  createMemoryStatusRoutes,
} from "./memory-status";
import type { MemoryPlaneStatus } from "./memory-status";

const log = getLogger(["hub", "memory-mount"]);

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
};

export type MemoryMountHandle = {
  readonly memory: Memory;
};

/**
 * Resolves the caller's own tenant (as set by the host's tenant-session
 * middleware) up to its bench/account tenant, and seats that as the scope
 * `registerMemoryRoutes` sees — never the workbench tenant a browser
 * session happens to be viewing. The caller's own principal id rides
 * through unchanged: only the SCOPE (which store) is remapped, not who is
 * asking.
 *
 * `OperatorTenantHasNoAccountScopeError` (the caller's own tenant IS the
 * operator tenant — no account beneath it) is treated the same as "could
 * not authenticate": `null`, which `@corbits/memory`'s `resolveCaller`
 * turns into a 401. Any other failure (a genuine database fault) is left
 * to propagate, same as an unexpected failure anywhere else in this route
 * tree.
 */
export function createAccountCallerResolver(
  db: DB["db"],
  operatorTenantId: string | undefined,
): CallerResolver {
  return async (c: Context<TenantEnv>) => {
    const principal = c.get("principal");
    const tenant = c.get("tenant");
    if (!principal || !tenant) return null;

    try {
      const accountTenantId = await resolveAccountTenantId({
        db,
        tenantId: tenant.id,
        ...(operatorTenantId !== undefined ? { operatorTenantId } : {}),
      });
      return { tenantId: accountTenantId, principalId: principal.id };
    } catch (cause) {
      if (cause instanceof OperatorTenantHasNoAccountScopeError) {
        log.warn(
          `memory: ${cause.message} (tenant ${tenant.id} is the operator tenant)`,
        );
        return null;
      }
      throw cause;
    }
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
  );

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
    }) as never,
  );

  log.info(
    `Memory plane mounted at /api/tenants/:tenantId/memory/* (source: ${resolution.source})`,
  );
  return { memory };
}
