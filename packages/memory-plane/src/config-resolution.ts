// Resolves a `MemoryConfig` for one tenant, in the order the memory
// settings page reports back: environment variables first (an operator's
// own deploy-wide embed endpoint), then a connected OpenAI credential
// (a hosted tenant's own key, connected long after boot), then
// lexical-only (no embed endpoint at all — full-text search only, needing
// nothing but the pgvector-capable Postgres every tenant already has).
// Each step is a small, independently testable function; `resolveMemoryConfig`
// only sequences them and names which one won, so the settings status
// route never has to re-derive that decision.
import { type } from "arktype";
import { credentialAad, type CredentialCipher } from "@intx/types";
import { resolveCredentialRequirement, type DB } from "@intx/db";
import { PROVIDER_TEST_CONFIG } from "@workbench/hub-client/credential-test";
import { parseFtsLanguage, type MemoryConfig } from "@corbits/memory";

/** The one provider precedence step (b) connects to: real OpenAI's own API,
 * the one connector in the registry with a genuinely OpenAI-compatible
 * embeddings endpoint every other "openai-compatible" chat provider does
 * not reliably serve. */
export const CONNECTED_CREDENTIAL_PROVIDER_NAME = "openai";

/** A small, broadly-available OpenAI embedding model — used only when the
 * embed endpoint itself came from a connected credential rather than an
 * operator's own `EMBED_MODEL`, which always wins when set. */
export const CONNECTED_CREDENTIAL_EMBED_MODEL = "text-embedding-3-small";

export type MemoryConfigSource =
  "env" | "connected-credential" | "lexical-only";

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
function readEngineBaseFromEnv(
  env: Env,
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
    throw new Error(`invalid memory-plane environment: ${parsed.summary}`);
  }
  const databaseUrl = env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
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
 * Step (a): environment variables. `undefined` (never a throw) means "no
 * embed endpoint was configured this way" so the next step gets a turn — a
 * blank or partially-set `EMBED_*` block is a real operator mistake and
 * throws instead of silently falling through to a connected credential.
 */
export function resolveConfigFromEnv(env: Env): MemoryConfig | undefined {
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
    throw new Error(`invalid memory-plane environment: ${parsed.summary}`);
  }

  return {
    memory: {
      ...readEngineBaseFromEnv(env),
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

export type ConnectedCredentialArgs = {
  readonly env: Env;
  readonly db: DB["db"];
  readonly tenantId: string;
  readonly credentialCipher: CredentialCipher;
};

/**
 * Step (b): a tenant-owned OpenAI credential connected through the
 * Connections surface (`packages/connections`), resolved the same
 * ownership-walk-the-ancestor-chain way a definition's model requirements
 * are (`@intx/db`'s `resolveCredentialRequirement` — never a hand-rolled
 * query). `source: "tenant"` matches a tenant-owned credential only, never
 * a principal's personal one. `undefined` means this tenant (and its
 * ancestors) never connected OpenAI — not an error, the next step decides.
 */
export async function resolveConfigFromConnectedCredential(
  args: ConnectedCredentialArgs,
): Promise<MemoryConfig | undefined> {
  const resolved = await resolveCredentialRequirement(
    args.db,
    args.tenantId,
    { providerName: CONNECTED_CREDENTIAL_PROVIDER_NAME, source: "tenant" },
    null,
    null,
  );
  if (resolved === null) return undefined;

  const apiKey = await args.credentialCipher.decrypt(
    resolved.credential.secret,
    credentialAad(resolved.credential.id, "secret"),
  );

  return {
    memory: {
      ...readEngineBaseFromEnv(args.env),
      embed: {
        baseUrl: PROVIDER_TEST_CONFIG.openai.baseURL,
        model: CONNECTED_CREDENTIAL_EMBED_MODEL,
        apiStyle: "openai",
        apiKey,
        timeoutMs: positiveInt(
          args.env["EMBED_TIMEOUT_MS"],
          "EMBED_TIMEOUT_MS",
        ),
      },
    },
  };
}

/**
 * Step (c): lexical-only. Needs nothing beyond `DATABASE_URL` (already
 * required for the hub to boot at all) and a pgvector-capable Postgres —
 * `runMemoryMigrations` still runs the same migration either way, since
 * dense retrieval can be added later without a schema change. The engine
 * omits `embed` entirely rather than this module inventing a placeholder
 * one: absent means "no embed endpoint configured," which
 * `Memory.capabilities.embeddingsConfigured` reports as `false` for the
 * status route to read back, never re-derived here.
 */
export function resolveConfigLexicalOnly(env: Env): MemoryConfig {
  return { memory: readEngineBaseFromEnv(env) };
}

export type ResolveMemoryConfigArgs = ConnectedCredentialArgs;

/**
 * Runs the precedence steps in order and names which one won — the exact
 * decision the status route reports back, never re-derived by the UI.
 * Always resolves to something: lexical-only is the floor, not a failure.
 */
export async function resolveMemoryConfig(
  args: ResolveMemoryConfigArgs,
): Promise<MemoryConfigResolution> {
  const fromEnv = resolveConfigFromEnv(args.env);
  if (fromEnv !== undefined) return { source: "env", config: fromEnv };

  const fromConnectedCredential =
    await resolveConfigFromConnectedCredential(args);
  if (fromConnectedCredential !== undefined) {
    return { source: "connected-credential", config: fromConnectedCredential };
  }

  return {
    source: "lexical-only",
    config: resolveConfigLexicalOnly(args.env),
  };
}
