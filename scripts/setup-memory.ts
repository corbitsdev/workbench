// bun run setup:memory — recommends how to turn on the memory plane
// (embeddings-backed recall) and its optional reranker for this checkout.
// Advisory for reranking and remote endpoints; for a local embed path it
// also writes missing EMBED_* keys into `.env` so `bun run dev` actually
// mounts `@corbits/memory` instead of leaving the plane dark. It never
// runs Docker or installs anything itself.
//
// Embedding is the hard requirement: memory_search/memory_add/memory_list
// answer with a plain "memory isn't set up on this server yet" note
// without it (apps/hub/src/memory-mount.ts), and even once it's on,
// rows written before EMBED_BASE_URL was set are NOT retroactively
// embedded — migrations create the tables either way, but there is no
// automatic backfill. Reranking is a pure enhancement: search works
// without it, just less well-ordered, and a reranker outage degrades
// search quietly rather than breaking it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type CapabilityProbe = {
  readonly hasNativeOllama: boolean;
  readonly hasDocker: boolean;
};

export type SetupPlan = {
  readonly strategy: string;
  readonly env: Record<string, string>;
  readonly instructions: readonly string[];
};

export function planEmbedding(probe: CapabilityProbe): SetupPlan {
  if (probe.hasNativeOllama) {
    return {
      strategy: "native-ollama",
      env: {
        EMBED_BASE_URL: "http://localhost:11434",
        EMBED_MODEL: "nomic-embed-text",
        EMBED_API_STYLE: "ollama",
      },
      instructions: [
        "Native Ollama found on this machine — use it directly, no container needed.",
        "  ollama pull nomic-embed-text",
        "  ollama serve   # if it isn't already running",
        "Then add to .env:",
        "  EMBED_BASE_URL=http://localhost:11434",
        "  EMBED_MODEL=nomic-embed-text",
        "  EMBED_API_STYLE=ollama",
      ],
    };
  }
  if (probe.hasDocker) {
    return {
      strategy: "docker-ollama",
      env: {
        EMBED_BASE_URL: "http://localhost:11434",
        EMBED_MODEL: "nomic-embed-text",
        EMBED_API_STYLE: "ollama",
      },
      instructions: [
        "No native Ollama on PATH, but Docker is available — brew install ollama is",
        "still the preferred path (no container to keep running); this is the fallback:",
        "  docker run -d --name workbench-ollama -p 11434:11434 ollama/ollama",
        "  docker exec workbench-ollama ollama pull nomic-embed-text",
        "Then add to .env:",
        "  EMBED_BASE_URL=http://localhost:11434",
        "  EMBED_MODEL=nomic-embed-text",
        "  EMBED_API_STYLE=ollama",
      ],
    };
  }
  return {
    strategy: "endpoint",
    env: {},
    instructions: [
      "Neither a native Ollama nor Docker was found on this machine.",
      "Point EMBED_BASE_URL at an existing endpoint instead — your own remote",
      "Ollama instance, a managed embedding API, or a Text Embeddings Inference",
      "server running elsewhere. Add to .env:",
      "  EMBED_BASE_URL=<your endpoint>",
      "  EMBED_MODEL=<the model that endpoint serves>",
      "  EMBED_API_STYLE=<openai (default) | ollama | tei>",
      "  EMBED_API_KEY=<if the endpoint requires one>",
      "See .env.example for worked examples of each.",
    ],
  };
}

export function planRerank(probe: CapabilityProbe): SetupPlan {
  // No native story here on purpose: the reranker is a cross-encoder
  // server (Text Embeddings Inference), not something brew ships. Docker
  // is the preferred local path when embedding didn't already need it.
  if (probe.hasDocker) {
    return {
      strategy: "docker-tei",
      env: {
        RERANK_BASE_URL: "http://localhost:8081",
        RERANK_MODEL: "BAAI/bge-reranker-base",
      },
      instructions: [
        "Docker is available — run a Text Embeddings Inference reranker:",
        "  docker run -d --name workbench-reranker -p 8081:80 \\",
        "    ghcr.io/huggingface/text-embeddings-inference:cpu-latest \\",
        "    --model-id BAAI/bge-reranker-base",
        "Then add to .env:",
        "  RERANK_BASE_URL=http://localhost:8081",
        "  RERANK_MODEL=BAAI/bge-reranker-base",
        "Optional — leaving both unset skips reranking; search still works,",
        "just ordered by vector/full-text fusion alone rather than a cross-encoder pass.",
      ],
    };
  }
  return {
    strategy: "endpoint",
    env: {},
    instructions: [
      "No Docker found for a local reranker (there's no native install path for one).",
      "Point RERANK_BASE_URL at a Text-Embeddings-Inference-compatible endpoint",
      "running elsewhere instead. Add to .env:",
      "  RERANK_BASE_URL=<your endpoint>",
      "  RERANK_MODEL=<the model that endpoint serves>",
      "  RERANK_API_KEY=<if the endpoint requires one>",
      "Optional — leaving both unset skips reranking; search still works,",
      "just ordered by vector/full-text fusion alone rather than a cross-encoder pass.",
    ],
  };
}

function nonempty(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value;
}

/**
 * Env `bun run dev` should inject into the hub process when the operator
 * has not set `EMBED_BASE_URL` / `OLLAMA_BASE_URL` but native Ollama is
 * on PATH — a local embed path exists, so the plane should not stay dark.
 * `OLLAMA_BASE_URL` is left to `mountMemory` (it is already a configured
 * embed origin).
 */
export function localDevMemoryEmbedEnv(
  env: Record<string, string | undefined>,
  probe: Pick<CapabilityProbe, "hasNativeOllama">,
): Record<string, string> | undefined {
  if (nonempty(env["EMBED_BASE_URL"]) !== undefined) return undefined;
  if (nonempty(env["OLLAMA_BASE_URL"]) !== undefined) return undefined;
  if (!probe.hasNativeOllama) return undefined;
  return planEmbedding({ hasNativeOllama: true, hasDocker: false }).env;
}

export function dotenvHasActiveKey(text: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}=`, "m").test(text);
}

export function applyEnvKeysToDotenvContents(
  existing: string,
  keys: Record<string, string>,
): { next: string; added: readonly string[] } {
  const added: string[] = [];
  let next = existing;
  for (const [key, value] of Object.entries(keys)) {
    if (dotenvHasActiveKey(next, key)) continue;
    added.push(key);
    if (next !== "" && !next.endsWith("\n")) next += "\n";
    next += `${key}=${value}\n`;
  }
  return { next, added };
}

// `docker info` against an unreachable or slow-to-wake daemon (a stopped
// Docker Desktop, a misconfigured remote context) can hang far longer than
// a setup script should ever block for, so this probe is bounded by a
// short timeout rather than trusted to return promptly on its own — a
// probe that can hang is worse than one that under-detects Docker.
const DOCKER_PROBE_TIMEOUT_MS = 3000;

async function dockerIsReachable(): Promise<boolean> {
  if (Bun.which("docker") === null) return false;
  try {
    const proc = Bun.spawn(["docker", "info"], {
      stdout: "ignore",
      stderr: "ignore",
      signal: AbortSignal.timeout(DOCKER_PROBE_TIMEOUT_MS),
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

async function probeCapabilities(): Promise<CapabilityProbe> {
  const hasNativeOllama = Bun.which("ollama") !== null;
  const hasDocker = await dockerIsReachable();
  return { hasNativeOllama, hasDocker };
}

function printPlan(title: string, plan: SetupPlan): void {
  console.log(`\n${title} (${plan.strategy}):`);
  for (const line of plan.instructions) console.log(`  ${line}`);
}

async function main(): Promise<void> {
  const probe = await probeCapabilities();
  console.log("Memory plane setup recommendation for this machine:");
  console.log(
    `  native Ollama: ${probe.hasNativeOllama ? "found" : "not found"}`,
  );
  console.log(`  Docker: ${probe.hasDocker ? "available" : "not available"}`);

  const embedPlan = planEmbedding(probe);
  printPlan(
    "Embedding (required for memory search to find anything)",
    embedPlan,
  );
  printPlan(
    "Reranking (optional — improves result ordering)",
    planRerank(probe),
  );

  const envPath = join(resolve(import.meta.dir, ".."), ".env");
  if (Object.keys(embedPlan.env).length > 0) {
    if (!existsSync(envPath)) {
      console.log(
        "\nNo .env yet — cp .env.example .env, then re-run to write the embedding keys.",
      );
    } else {
      const current = readFileSync(envPath, "utf8");
      const { next, added } = applyEnvKeysToDotenvContents(
        current,
        embedPlan.env,
      );
      if (added.length > 0) {
        writeFileSync(envPath, next);
        console.log(`\nWrote ${added.join(", ")} to .env`);
      } else {
        console.log("\n.env already has embedding keys — left unchanged.");
      }
    }
  }

  console.log(
    "\nAfter editing .env, restart `bun run dev` — it applies memory's migrations\n" +
      "automatically. If you add EMBED_BASE_URL after rows already exist, those\n" +
      "existing rows are NOT retroactively embedded; only new writes get embedded.",
  );
}

if (import.meta.main) {
  await main();
}
