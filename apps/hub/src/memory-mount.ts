/**
 * Hub-side memory plane mount — host analog of Scout dock's `mountKnowledge`
 * (`packages/agent-dock/src/knowledge.ts`). `@corbits/memory` (git pin) owns
 * the firm-memory plane + HTTP under `/api/tenants/:tenantId/memory/*`,
 * isolated in its own `memory` Postgres schema (drizzle `pgSchema`) — the
 * same idiom `@corbits/mailbox` uses for `mailbox` and `@corbits/artifacts`
 * for `artifacts`. There is exactly one Postgres URL for this hub:
 * `DATABASE_URL`, and `@corbits/memory`'s own `loadMemoryConfig()` reads it
 * directly, so this module just calls it.
 *
 * Degrades cleanly when unconfigured: missing `EMBED_BASE_URL` means "no
 * memory plane", logged once at boot, never thrown — same optional-engine
 * contract as the artifacts mount. When `EMBED_BASE_URL` is present, boot
 * fails loudly if migrate/create throws so a half-wired deploy is never
 * silent.
 *
 * This module lands the mount + factory only. Capture/ingestion glue is a
 * later ticket; agents that want firm memory ask the returned handle.
 *
 * Boundary casts (`as never`) match Scout: `@corbits/memory` ships against its
 * own Hono/authz type copies, and Hono env + ConditionRegistry are invariant
 * across package roots — cast only at the mount boundary.
 */
import type { Hono } from "hono";
import { type } from "arktype";
import type { ConditionRegistry, GrantStore } from "@intx/authz";
import { getLogger } from "@intx/log";
import {
  createMemory,
  loadMemoryConfig,
  runMemoryMigrations,
  type Memory,
} from "@corbits/memory";

const log = getLogger(["hub", "memory-mount"]);

// The one boundary this module parses: whether the memory plane is
// configured at all. `"string > 0"` rejects a blank `EMBED_BASE_URL=`
// the same as an absent one — both mean "no memory plane" — while
// catching a non-string env value at the arktype boundary rather than
// letting a falsy check quietly wave through something unexpected.
const MemoryMountEnv = type({
  "EMBED_BASE_URL?": "string > 0",
});

function embedBaseUrlFrom(
  env: Record<string, string | undefined>,
): string | undefined {
  // Build the input object with the key OMITTED rather than present with
  // an `undefined` value: arktype's optional-key check is keyed off
  // property presence, and `process.env` (and this suite's env stashing)
  // both sometimes leave an unset variable as a present-but-`undefined`
  // own property rather than an absent one.
  const rawValue = env["EMBED_BASE_URL"];
  const input = rawValue === undefined ? {} : { EMBED_BASE_URL: rawValue };
  const parsed = MemoryMountEnv(input);
  if (parsed instanceof type.errors) {
    throw new Error(`invalid memory-plane environment: ${parsed.summary}`);
  }
  return parsed.EMBED_BASE_URL;
}

export type MountMemoryOptions<E extends object = object> = {
  /** Hub Hono app (routes register under tenant memory paths). */
  app: Hono<E>;
  grantStore: GrantStore;
  conditionRegistry: ConditionRegistry;
  /**
   * When true (default), skip mount if `EMBED_BASE_URL` is unset. Tests can
   * force a mount attempt by setting env + `optional: false`.
   */
  optional?: boolean;
};

export type MemoryMountHandle = {
  memory: Memory;
};

/**
 * Returns a memory handle when the plane is configured and mounted;
 * `undefined` when optional and `EMBED_BASE_URL` is absent.
 */
export async function mountMemory<E extends object = object>(
  options: MountMemoryOptions<E>,
): Promise<MemoryMountHandle | undefined> {
  const optional = options.optional !== false;
  const embedBaseUrl = embedBaseUrlFrom(process.env);
  if (embedBaseUrl === undefined) {
    if (optional) {
      log.info("EMBED_BASE_URL not set — memory plane will not be mounted");
      return undefined;
    }
    throw new Error("EMBED_BASE_URL is required to mount memory");
  }

  const config = loadMemoryConfig();
  await runMemoryMigrations(config.memory.databaseUrl, {
    ftsLanguage: config.memory.ftsLanguage,
  });
  const memory = createMemory({
    app: options.app as never,
    config,
    grantStore: options.grantStore as never,
    conditionRegistry: options.conditionRegistry as never,
  });

  log.info("Memory plane mounted at /api/tenants/:tenantId/memory/*");
  return { memory };
}
