// Resolves a `MemoryConfig` for the whole process. Memory is configured at
// the ENV level only (deployment infrastructure, one per process) — never
// per-tenant, and never from a connected credential: which embeddings
// endpoint the engine uses is a wholly separate axis from whose memories a
// request reaches (that second axis — data scope — is resolved per
// request by `@corbits/memory-hub`'s `resolveAccountTenantId`, never here).
// Two states only, in order:
//
//   1. `EMBED_BASE_URL` below, if set — one embed endpoint for the whole
//      deploy.
//   2. Otherwise, lexical-only: full-text search only, no embed endpoint
//      at all. Needs nothing beyond a pgvector-capable Postgres — this is
//      a fully-supported mode, not a degraded one, so there is no "memory
//      isn't set up" state; every tenant always gets at least lexical
//      search.
//
// `databaseUrl` is taken as an explicit argument, never re-read from raw
// env here: the hub already parsed and validated `DATABASE_URL` into
// `HubConfig.databaseUrl` (`apps/hub/src/config.ts`) once, at its own trust
// boundary — this module reuses that resolved value rather than deriving a
// second, possibly-divergent one from `process.env` itself.
//
// Each step is a small, independently testable function; `resolveMemoryConfig`
// only sequences them and names which one won, so the settings status
// route never has to re-derive that decision.
import { type } from "arktype";
import { parseFtsLanguage, type MemoryConfig } from "@corbits/memory";

export type MemoryConfigSource = "env" | "lexical-only";

export type MemoryConfigResolution = {
  readonly source: MemoryConfigSource;
  readonly config: MemoryConfig;
};

const EngineEnv = type({
  "DB_POOL_MAX?": "string > 0",
  "FTS_LANGUAGE?": "string > 0",
  "RERANK_BASE_URL?": "string > 0",
  "RERANK_MODEL?": "string > 0",
  "RERANK_API_KEY?": "string > 0",
  "RERANK_MAX_DOC_CHARS?": "string > 0",
  "RERANK_TIMEOUT_MS?": "string > 0",
});

const EmbedEnv = type({
  EMBED_BASE_URL: "string > 0",
  EMBED_MODEL: "string > 0",
  "EMBED_API_STYLE?": "string > 0",
  "EMBED_API_KEY?": "string > 0",
  "EMBED_TIMEOUT_MS?": "string > 0",
});

type Env = Record<string, string | undefined>;

function presentEnv(env: Env, keys: readonly string[]): Record<string, string> {
  const present: Record<string, string> = {};
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value !== "") present[key] = value;
  }
  return present;
}

function positiveInt(
  raw: string | undefined,
  label: string,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return n;
}

/** Rerank + pool + FTS knobs: independent of which embed step won, read the
 * same way for both. */
function readEngineBase(
  env: Env,
  databaseUrl: string,
): Omit<MemoryConfig["memory"], "embed"> {
  const parsed = EngineEnv(
    presentEnv(env, [
      "DB_POOL_MAX",
      "FTS_LANGUAGE",
      "RERANK_BASE_URL",
      "RERANK_MODEL",
      "RERANK_API_KEY",
      "RERANK_MAX_DOC_CHARS",
      "RERANK_TIMEOUT_MS",
    ]),
  );
  if (parsed instanceof type.errors) {
    throw new Error(`invalid memory environment: ${parsed.summary}`);
  }
  if (databaseUrl === "") {
    throw new Error("DATABASE_URL is required to configure the memory plane");
  }
  return {
    databaseUrl,
    dbPoolMax: positiveInt(parsed.DB_POOL_MAX, "DB_POOL_MAX") ?? 8,
    ftsLanguage: parseFtsLanguage(parsed.FTS_LANGUAGE),
    rerank: {
      baseUrl: parsed.RERANK_BASE_URL,
      model: parsed.RERANK_MODEL,
      apiKey: parsed.RERANK_API_KEY,
      maxDocChars: positiveInt(
        parsed.RERANK_MAX_DOC_CHARS,
        "RERANK_MAX_DOC_CHARS",
      ),
      timeoutMs: positiveInt(parsed.RERANK_TIMEOUT_MS, "RERANK_TIMEOUT_MS"),
    },
  };
}

/**
 * Step 1: environment variables. `undefined` (never a throw) means "no
 * embed endpoint was configured" so the lexical-only floor applies — a
 * blank or partially-set `EMBED_*` block is a real operator mistake and
 * throws instead of silently falling through.
 */
export function resolveConfigFromEnv(
  env: Env,
  databaseUrl: string,
): MemoryConfig | undefined {
  const embedBaseUrl = env["EMBED_BASE_URL"];
  if (embedBaseUrl === undefined || embedBaseUrl === "") return undefined;

  const parsed = EmbedEnv(
    presentEnv(env, [
      "EMBED_BASE_URL",
      "EMBED_MODEL",
      "EMBED_API_STYLE",
      "EMBED_API_KEY",
      "EMBED_TIMEOUT_MS",
    ]),
  );
  if (parsed instanceof type.errors) {
    throw new Error(`invalid memory environment: ${parsed.summary}`);
  }

  return {
    memory: {
      ...readEngineBase(env, databaseUrl),
      embed: {
        baseUrl: parsed.EMBED_BASE_URL,
        model: parsed.EMBED_MODEL,
        apiStyle: parsed.EMBED_API_STYLE ?? "openai",
        apiKey: parsed.EMBED_API_KEY,
        timeoutMs: positiveInt(parsed.EMBED_TIMEOUT_MS, "EMBED_TIMEOUT_MS"),
      },
    },
  };
}

/**
 * Step 2: lexical-only. Needs nothing beyond `DATABASE_URL` (already
 * required for the hub to boot at all) and a pgvector-capable Postgres —
 * `runMemoryMigrations` still runs the same migration either way, since
 * dense retrieval can be added later without a schema change. The engine
 * omits `embed` entirely rather than this module inventing a placeholder
 * one: absent means "no embed endpoint configured," which
 * `Memory.capabilities.embeddingsConfigured` reports as `false` for the
 * status route to read back, never re-derived here.
 */
export function resolveConfigLexicalOnly(
  env: Env,
  databaseUrl: string,
): MemoryConfig {
  return { memory: readEngineBase(env, databaseUrl) };
}

export type ResolveMemoryConfigArgs = {
  readonly env: Env;
  readonly databaseUrl: string;
};

/**
 * Runs the two steps in order and names which one won — the exact
 * decision the status route reports back, never re-derived by the UI.
 * Always resolves to something: lexical-only is the floor, not a failure.
 * Pure and synchronous — env and the hub's own resolved `databaseUrl` are
 * both known at boot, so this never touches a database or a credential
 * store.
 */
export function resolveMemoryConfig(
  args: ResolveMemoryConfigArgs,
): MemoryConfigResolution {
  const fromEnv = resolveConfigFromEnv(args.env, args.databaseUrl);
  if (fromEnv !== undefined) return { source: "env", config: fromEnv };

  return {
    source: "lexical-only",
    config: resolveConfigLexicalOnly(args.env, args.databaseUrl),
  };
}
