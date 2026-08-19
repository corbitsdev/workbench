/**
 * Hub-side memory plane mount — composition root. `@corbits/memory` is the
 * domain: it already ships its own engine, its own HTTP routes
 * (`registerMemoryRoutes`), and its own capability facts
 * (`Memory.capabilities`). This module's only job is composing that
 * upstream library against this hub's own `db`, `credentialCipher`, grant
 * store, and condition registry — resolving which config a tenant gets
 * (`./memory-config`), building the real engine lazily on first use, and
 * mounting upstream's routes plus the read-only status route
 * (`./memory-status`) exactly once.
 *
 * Lazy, not boot-time: a credential gets connected long after boot, so a
 * boot-only build would mean "connect a key" still needs a redeploy. The
 * real `@corbits/memory` engine (DB pool, migrations, embed client) only
 * builds on a tenant's first actual call. `MemoryConfig` is one config for
 * the whole process (one embed endpoint, one Postgres) even though *which*
 * config wins can depend on which tenant asks first — env is process-wide
 * by definition; a connected credential is resolved against whichever
 * tenant's first request triggers the build; lexical-only is the floor
 * when neither applies. A single in-flight build is memoized across every
 * tenant; a rejection is never cached, so the next call re-resolves from
 * scratch rather than replaying a stuck failure forever.
 *
 * `createMemory({ app })`/`registerMemoryRoutes` register HTTP routes as a
 * side effect and are not safe to call twice — `mountMemory` is the one
 * place that calls `registerMemoryRoutes`, once, at hub start, against a
 * `Memory` proxy whose real engine resolves later. Every consumer of the
 * returned handle (chat orchestrator, artifact delivery, the
 * workflow-memory store) already only calls `add`/`search`/`list`, so this
 * lazy `Memory` is a drop-in: it resolves for real on first use and answers
 * a clear 503 (via `MemoryError`) until it is configured.
 *
 * Boundary casts (`as never`) match Scout's `mountKnowledge`
 * (`packages/agent-dock/src/knowledge.ts`): `@corbits/memory` ships against
 * its own Hono/authz type copies, and Hono env + ConditionRegistry are
 * invariant across package roots — cast only at this mount boundary.
 */
import type { Hono } from "hono";
import {
  createMemory as buildMemoryPlane,
  runMemoryMigrations,
  MemoryError,
  getDegradeMetricsSnapshot,
  registerMemoryRoutes,
  type Memory,
  type MemoryConfig,
} from "@corbits/memory";
import type { ConditionRegistry, GrantStore } from "@intx/authz";
import type { CredentialCipher } from "@intx/types";
import type { DB } from "@intx/db";
import { createRequireGrant } from "@intx/hub-api";
import { getLogger } from "@intx/log";

import { resolveMemoryConfig, type MemoryConfigSource } from "./memory-config";
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
  credentialCipher: CredentialCipher;
  grantStore: GrantStore;
  conditionRegistry: ConditionRegistry;
};

export type MemoryMountHandle = {
  /** Resolves its real engine lazily per tenant call. */
  memory: Memory;
};

type BuiltPlane = {
  readonly source: MemoryConfigSource;
  readonly config: MemoryConfig;
  readonly memory: Memory;
};

export type LazyMemoryPlaneDeps = {
  readonly env: Record<string, string | undefined>;
  readonly db: DB["db"];
  readonly credentialCipher: CredentialCipher;
  readonly grantStore: GrantStore;
  readonly conditionRegistry: ConditionRegistry;
};

export type LazyMemoryPlane = {
  /** Pass to `registerMemoryRoutes(app, { memory, ... })` — exactly once.
   * Its own `capabilities` is a placeholder never read by any mounted
   * route; the real, per-tenant-resolved answer is what `describeStatus`
   * reports. */
  readonly memory: Memory;
  /** For the `/memory/status` route. A genuine infrastructure fault (a
   * migration failure, an unreachable database) throws — that is a
   * different thing than "this tenant is on lexical-only", which is a
   * normal, fully-available status, not an error. */
  describeStatus(tenantId: string): Promise<MemoryPlaneStatus>;
};

export function createLazyMemoryPlane(
  deps: LazyMemoryPlaneDeps,
): LazyMemoryPlane {
  // Single-flight: concurrent first callers await the same attempt rather
  // than racing separate migration runs; a rejection clears this so the
  // very next call starts a fresh attempt instead of replaying a cached
  // failure forever.
  let pending: Promise<BuiltPlane> | undefined;

  function resolveAndBuild(tenantId: string): Promise<BuiltPlane> {
    if (pending !== undefined) return pending;
    const attempt = (async (): Promise<BuiltPlane> => {
      const resolution = await resolveMemoryConfig({
        env: deps.env,
        db: deps.db,
        tenantId,
        credentialCipher: deps.credentialCipher,
      });
      await runMemoryMigrations(resolution.config.memory.databaseUrl, {
        ftsLanguage: resolution.config.memory.ftsLanguage,
      });
      const memory = buildMemoryPlane({
        config: resolution.config,
        grantStore: deps.grantStore,
        conditionRegistry: deps.conditionRegistry,
      });
      return { source: resolution.source, config: resolution.config, memory };
    })();
    pending = attempt;
    attempt.catch(() => {
      pending = undefined;
    });
    return attempt;
  }

  const memory: Memory = {
    // Never actually read by any route `registerMemoryRoutes` mounts
    // (verified against the current `@corbits/memory` source) — required
    // only to satisfy the `Memory` shape at registration time, before any
    // tenant's real plane has resolved.
    capabilities: { embeddingsConfigured: true },
    async add(params) {
      return (await resolveAndBuild(params.tenantId)).memory.add(params);
    },
    async search(params) {
      return (await resolveAndBuild(params.tenantId)).memory.search(params);
    },
    async list(params) {
      return (await resolveAndBuild(params.tenantId)).memory.list(params);
    },
    async feed(params) {
      const real = (await resolveAndBuild(params.tenantId)).memory;
      if (real.feed === undefined) {
        throw new MemoryError(
          501,
          "feed is not implemented by the configured memory plane",
        );
      }
      return real.feed(params);
    },
    async close() {
      if (pending === undefined) return;
      const built = await pending.catch(() => undefined);
      await built?.memory.close();
    },
  };

  async function describeStatus(tenantId: string): Promise<MemoryPlaneStatus> {
    const built = await resolveAndBuild(tenantId);
    const degrade = getDegradeMetricsSnapshot(tenantId);
    return buildMemoryPlaneStatus(
      built.source,
      built.config,
      built.memory.capabilities,
      degrade,
    );
  }

  return { memory, describeStatus };
}

export function mountMemory<E extends object = object>(
  options: MountMemoryOptions<E>,
): MemoryMountHandle {
  const plane = createLazyMemoryPlane({
    env: process.env,
    db: options.db,
    credentialCipher: options.credentialCipher,
    grantStore: options.grantStore,
    conditionRegistry: options.conditionRegistry,
  });
  const grants = {
    grantStore: options.grantStore,
    conditionRegistry: options.conditionRegistry,
  };
  const requireGrant = createRequireGrant(grants);

  registerMemoryRoutes(options.app as never, {
    memory: plane.memory,
    requireGrant: requireGrant as never,
    grants: grants as never,
  });
  options.app.route(
    "/api/tenants/:tenantId/memory",
    createMemoryStatusRoutes({
      plane,
      requireGrant: requireGrant as never,
    }) as never,
  );

  log.info(
    "Memory plane mount point registered at /api/tenants/:tenantId/memory/* " +
      "(builds lazily on first use)",
  );
  return { memory: plane.memory };
}
