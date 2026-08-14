/**
 * Hub-side memory plane mount — host analog of Scout dock's `mountKnowledge`
 * (`packages/agent-dock/src/knowledge.ts`). `@corbits/memory` (git pin) owns
 * the firm-memory plane + HTTP under `/api/tenants/:tenantId/memory/*`,
 * isolated in its own `knowledge` Postgres schema (drizzle `pgSchema`) —
 * the same idiom `@corbits/mailbox` uses for `mailbox` and
 * `@corbits/artifacts` for `artifacts`. There is exactly one Postgres URL
 * for this hub: `DATABASE_URL`.
 *
 * `@corbits/memory`'s own `loadMemoryConfig()` deliberately requires a
 * second `KNOWLEDGE_DATABASE_URL` env var and refuses a `DATABASE_URL`
 * fallback — a decision made inside that package, not this repo. `MemoryConfig`
 * is built by hand here instead, so the hub's single `DATABASE_URL` backs the
 * `knowledge` schema exactly like it backs `mailbox` and `artifacts`.
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
import type { ConditionRegistry, GrantStore } from "@intx/authz";
import { getLogger } from "@intx/log";
import {
  createMemory,
  parseFtsLanguage,
  runMemoryMigrations,
  type Memory,
  type MemoryConfig,
} from "@corbits/memory";

const log = getLogger(["hub", "memory-mount"]);

export type MountMemoryOptions<E extends object = object> = {
  /** Hub Hono app (routes register under tenant memory paths). */
  app: Hono<E>;
  grantStore: GrantStore;
  conditionRegistry: ConditionRegistry;
  /** Defaults to `process.env.DATABASE_URL`. */
  databaseUrl?: string;
  /**
   * When true (default), skip mount if `EMBED_BASE_URL` is unset. Tests can
   * force a mount attempt by setting env + `optional: false`.
   */
  optional?: boolean;
};

export type MemoryMountHandle = {
  memory: Memory;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function intEnv(name: string, fallback: number): number {
  const raw = optionalEnv(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

function optionalIntEnv(name: string): number | undefined {
  const raw = optionalEnv(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

/**
 * Builds `@corbits/memory`'s `MemoryConfig` from env — the same fields
 * `loadMemoryConfig` reads — except `databaseUrl` comes from the caller (the
 * hub's single `DATABASE_URL`) instead of `KNOWLEDGE_DATABASE_URL`.
 */
function buildMemoryConfig(databaseUrl: string): MemoryConfig {
  return {
    memory: {
      databaseUrl,
      dbPoolMax: intEnv("DB_POOL_MAX", 8),
      ftsLanguage: parseFtsLanguage(optionalEnv("FTS_LANGUAGE")),
      embed: {
        baseUrl: requireEnv("EMBED_BASE_URL"),
        model: requireEnv("EMBED_MODEL"),
        apiStyle: optionalEnv("EMBED_API_STYLE") ?? "openai",
        apiKey: optionalEnv("EMBED_API_KEY"),
        timeoutMs: optionalIntEnv("EMBED_TIMEOUT_MS"),
      },
      rerank: {
        baseUrl: optionalEnv("RERANK_BASE_URL"),
        model: optionalEnv("RERANK_MODEL"),
        apiKey: optionalEnv("RERANK_API_KEY"),
        maxDocChars: optionalIntEnv("RERANK_MAX_DOC_CHARS"),
        timeoutMs: optionalIntEnv("RERANK_TIMEOUT_MS"),
      },
    },
  };
}

/**
 * Returns a memory handle when the plane is configured and mounted;
 * `undefined` when optional and `EMBED_BASE_URL` is absent.
 */
export async function mountMemory<E extends object = object>(
  options: MountMemoryOptions<E>,
): Promise<MemoryMountHandle | undefined> {
  const optional = options.optional !== false;
  const embedBaseUrl = process.env["EMBED_BASE_URL"];
  if (!embedBaseUrl) {
    if (optional) {
      log.info("EMBED_BASE_URL not set — memory plane will not be mounted");
      return undefined;
    }
    throw new Error("EMBED_BASE_URL is required to mount memory");
  }

  const databaseUrl = options.databaseUrl ?? requireEnv("DATABASE_URL");
  const config = buildMemoryConfig(databaseUrl);
  await runMemoryMigrations(databaseUrl, {
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
