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
 * Embed resolution: explicit `EMBED_BASE_URL` wins. Otherwise a configured
 * `OLLAMA_BASE_URL` is a local embed path (same origin the hub already
 * plants as an inference credential), so local/dev does not leave the plane
 * dark when Ollama is already wired. Missing both means "no memory plane",
 * logged once at boot, never thrown — same optional-engine contract as the
 * artifacts mount. When an embed URL is present, boot fails loudly if
 * migrate/create throws so a half-wired deploy is never silent.
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

// The boundary this module parses: whether the memory plane is configured
// at all, and — when a reranker is in play — whether it's configured
// completely. `"string > 0"` rejects a blank value the same as an absent
// one, while catching a non-string env value at the arktype boundary
// rather than letting a falsy check quietly wave through something
// unexpected.
//
// RERANK_BASE_URL and RERANK_MODEL must be set together: `@corbits/memory`
// treats each independently optional and would otherwise let a
// half-configured reranker surface as a confusing runtime failure deep in
// its rerank client, rather than a boot-time error naming the missing
// half — the same "fail loud on a half-configured pair" contract this
// hub already applies to GOOGLE_CLIENT_ID/SECRET (see ../config.ts).
// Reranking itself stays a soft-fail enhancement once configured (a
// reranker outage degrades search quietly, never breaks it) — this check
// only guards against shipping a pair that can never work at all.
const MemoryMountEnv = type({
  "EMBED_BASE_URL?": "string > 0",
  "RERANK_BASE_URL?": "string > 0",
  "RERANK_MODEL?": "string > 0",
});

type ParsedMemoryMountEnv = typeof MemoryMountEnv.infer;

function omitUndefined(
  env: Record<string, string | undefined>,
  keys: readonly string[],
): Record<string, string> {
  // Build the input object with unset keys OMITTED rather than present
  // with an `undefined` value: arktype's optional-key check is keyed off
  // property presence, and `process.env` (and this suite's env stashing)
  // both sometimes leave an unset variable as a present-but-`undefined`
  // own property rather than an absent one.
  const input: Record<string, string> = {};
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined) input[key] = value;
  }
  return input;
}

function parseMemoryMountEnv(
  env: Record<string, string | undefined>,
): ParsedMemoryMountEnv {
  const input = omitUndefined(env, [
    "EMBED_BASE_URL",
    "RERANK_BASE_URL",
    "RERANK_MODEL",
  ]);
  const parsed = MemoryMountEnv(input);
  if (parsed instanceof type.errors) {
    throw new Error(`invalid memory-plane environment: ${parsed.summary}`);
  }
  if (
    (parsed.RERANK_BASE_URL === undefined) !==
    (parsed.RERANK_MODEL === undefined)
  ) {
    throw new Error(
      [
        "invalid memory-plane environment: RERANK_BASE_URL and RERANK_MODEL must be set together to enable reranking; only one is set",
        "Set both in .env, or unset both to search without reranking; see .env.example.",
      ].join("\n"),
    );
  }
  return parsed;
}

const LOCAL_OLLAMA_EMBED_MODEL = "nomic-embed-text";
const LOCAL_OLLAMA_EMBED_STYLE = "ollama";

export type ResolvedMemoryEmbed = {
  readonly embedBaseUrl: string;
  readonly embedModel: string;
  readonly embedApiStyle: string;
  readonly source: "EMBED_BASE_URL" | "OLLAMA_BASE_URL";
};

function nonemptyEnv(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key];
  if (value === undefined || value.trim() === "") return undefined;
  return value;
}

/**
 * Explicit `EMBED_BASE_URL` wins. Otherwise `OLLAMA_BASE_URL` is the local
 * embed path — nomic-embed-text / ollama style, matching `setup:memory`.
 */
export function resolveMemoryEmbed(
  env: Record<string, string | undefined>,
): ResolvedMemoryEmbed | undefined {
  const embedBaseUrl = nonemptyEnv(env, "EMBED_BASE_URL");
  if (embedBaseUrl !== undefined) {
    return {
      embedBaseUrl,
      embedModel: nonemptyEnv(env, "EMBED_MODEL") ?? "",
      embedApiStyle: nonemptyEnv(env, "EMBED_API_STYLE") ?? "openai",
      source: "EMBED_BASE_URL",
    };
  }
  const ollamaBaseUrl = nonemptyEnv(env, "OLLAMA_BASE_URL");
  if (ollamaBaseUrl === undefined) return undefined;
  return {
    embedBaseUrl: ollamaBaseUrl,
    embedModel: nonemptyEnv(env, "EMBED_MODEL") ?? LOCAL_OLLAMA_EMBED_MODEL,
    embedApiStyle:
      nonemptyEnv(env, "EMBED_API_STYLE") ?? LOCAL_OLLAMA_EMBED_STYLE,
    source: "OLLAMA_BASE_URL",
  };
}

function applyResolvedEmbedToProcessEnv(resolved: ResolvedMemoryEmbed): void {
  if (process.env["EMBED_BASE_URL"] === undefined) {
    process.env["EMBED_BASE_URL"] = resolved.embedBaseUrl;
  }
  if (process.env["EMBED_MODEL"] === undefined && resolved.embedModel !== "") {
    process.env["EMBED_MODEL"] = resolved.embedModel;
  }
  if (process.env["EMBED_API_STYLE"] === undefined) {
    process.env["EMBED_API_STYLE"] = resolved.embedApiStyle;
  }
}

export type MountMemoryOptions<E extends object = object> = {
  /** Hub Hono app (routes register under tenant memory paths). */
  app: Hono<E>;
  grantStore: GrantStore;
  conditionRegistry: ConditionRegistry;
  /**
   * When true (default), skip mount if neither `EMBED_BASE_URL` nor
   * `OLLAMA_BASE_URL` is set. Tests can force a mount attempt by setting
   * env + `optional: false`.
   */
  optional?: boolean;
};

export type MemoryMountHandle = {
  memory: Memory;
};

/**
 * Returns a memory handle when the plane is configured and mounted;
 * `undefined` when optional and neither `EMBED_BASE_URL` nor
 * `OLLAMA_BASE_URL` is present.
 */
export async function mountMemory<E extends object = object>(
  options: MountMemoryOptions<E>,
): Promise<MemoryMountHandle | undefined> {
  const optional = options.optional !== false;
  parseMemoryMountEnv(process.env);
  const resolved = resolveMemoryEmbed(process.env);
  if (resolved === undefined) {
    if (optional) {
      log.info(
        "EMBED_BASE_URL / OLLAMA_BASE_URL not set — memory plane will not be mounted",
      );
      return undefined;
    }
    throw new Error(
      "EMBED_BASE_URL or OLLAMA_BASE_URL is required to mount memory",
    );
  }
  applyResolvedEmbedToProcessEnv(resolved);
  if (resolved.source === "OLLAMA_BASE_URL") {
    log.info(
      `OLLAMA_BASE_URL set — mounting memory plane with embed ${resolved.embedBaseUrl} (${resolved.embedModel})`,
    );
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
