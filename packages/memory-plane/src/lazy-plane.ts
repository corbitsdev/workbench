// The lazy memory plane: a `Memory` a host can register with
// `@corbits/memory`'s `registerMemoryRoutes` exactly once, at boot, whose
// real engine (DB pool, migrations, embed client) is built on first actual
// use rather than at boot — so a credential connected long after boot
// takes effect with no restart, and boot never blocks on a plane nobody
// has asked for yet.
//
// `MemoryConfig` is one config for the whole process (one embed endpoint,
// one Postgres), even though *which* config wins can depend on which
// tenant asks first (env is process-wide by definition; a connected
// credential is resolved against whichever tenant's first request
// triggers the build; lexical-only is the floor when neither applies). A
// single in-flight build is memoized across every tenant; a rejection is
// never cached, so the next call re-resolves from scratch rather than
// replaying a stuck failure forever — the property that makes a
// migration hiccup recoverable without a restart.
import {
  createMemory as buildMemoryPlane,
  runMemoryMigrations,
  MemoryError,
  getDegradeMetricsSnapshot,
  type Memory,
  type MemoryConfig,
} from "@corbits/memory";
import type { ConditionRegistry, GrantStore } from "@intx/authz";
import type { CredentialCipher } from "@intx/types";
import type { DB } from "@intx/db";

import {
  resolveMemoryConfig,
  type MemoryConfigSource,
} from "./config-resolution";
import { buildMemoryPlaneStatus, type MemoryPlaneStatus } from "./status";

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

type BuiltPlane = {
  readonly source: MemoryConfigSource;
  readonly config: MemoryConfig;
  readonly memory: Memory;
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
