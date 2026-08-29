import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createInMemoryGrantStore } from "@intx/authz";

import {
  applyResolvedEmbedToProcessEnv,
  mountMemory,
  resolveMemoryEmbed,
} from "./memory-mount";

const KEYS = [
  "DATABASE_URL",
  "EMBED_BASE_URL",
  "EMBED_MODEL",
  "EMBED_API_STYLE",
  "EMBED_API_KEY",
  "RERANK_BASE_URL",
  "RERANK_MODEL",
  "OLLAMA_BASE_URL",
] as const;

type EnvKey = (typeof KEYS)[number];

const originals: Record<EnvKey, string | undefined> = {
  DATABASE_URL: process.env["DATABASE_URL"],
  EMBED_BASE_URL: process.env["EMBED_BASE_URL"],
  EMBED_MODEL: process.env["EMBED_MODEL"],
  EMBED_API_STYLE: process.env["EMBED_API_STYLE"],
  EMBED_API_KEY: process.env["EMBED_API_KEY"],
  RERANK_BASE_URL: process.env["RERANK_BASE_URL"],
  RERANK_MODEL: process.env["RERANK_MODEL"],
  OLLAMA_BASE_URL: process.env["OLLAMA_BASE_URL"],
};

function clearEnvKey(key: EnvKey): void {
  // Must actually remove the key: `process.env[key] = undefined` stores the
  // *string* "undefined" (Bun >= 1.4 matches Node here), which reads as a
  // configured value and makes every DATABASE_URL/EMBED_BASE_URL gate in this
  // app's suites fire against postgres.js's localhost:5432 default.
  // `Reflect.deleteProperty` because eslint forbids dynamic `delete`.
  Reflect.deleteProperty(process.env, key);
}

function restoreOriginalEnv(): void {
  for (const key of KEYS) {
    const value = originals[key];
    if (value === undefined) clearEnvKey(key);
    else process.env[key] = value;
  }
}

afterEach(restoreOriginalEnv);

function stashEnv(): void {
  for (const key of KEYS) {
    clearEnvKey(key);
  }
}

describe("resolveMemoryEmbed", () => {
  test("returns undefined when neither EMBED_BASE_URL nor OLLAMA_BASE_URL is set", () => {
    expect(resolveMemoryEmbed({})).toBeUndefined();
  });

  test("explicit EMBED_BASE_URL wins over OLLAMA_BASE_URL", () => {
    expect(
      resolveMemoryEmbed({
        EMBED_BASE_URL: "https://api.openai.com/v1",
        EMBED_MODEL: "text-embedding-3-small",
        OLLAMA_BASE_URL: "http://localhost:11434",
      }),
    ).toEqual({
      embedBaseUrl: "https://api.openai.com/v1",
      embedModel: "text-embedding-3-small",
      embedApiStyle: "openai",
      source: "EMBED_BASE_URL",
    });
  });

  test("OLLAMA_BASE_URL is a local embed path with nomic-embed-text / ollama style", () => {
    expect(
      resolveMemoryEmbed({
        OLLAMA_BASE_URL: "http://localhost:11434",
      }),
    ).toEqual({
      embedBaseUrl: "http://localhost:11434",
      embedModel: "nomic-embed-text",
      embedApiStyle: "ollama",
      source: "OLLAMA_BASE_URL",
    });
  });

  test("treats a blank OLLAMA_BASE_URL as unset", () => {
    expect(resolveMemoryEmbed({ OLLAMA_BASE_URL: "" })).toBeUndefined();
  });

  test("blank EMBED_MODEL / EMBED_API_STYLE on OLLAMA path resolve to nomic-embed-text / ollama", () => {
    expect(
      resolveMemoryEmbed({
        OLLAMA_BASE_URL: "http://localhost:11434",
        EMBED_MODEL: "",
        EMBED_API_STYLE: "  ",
      }),
    ).toEqual({
      embedBaseUrl: "http://localhost:11434",
      embedModel: "nomic-embed-text",
      embedApiStyle: "ollama",
      source: "OLLAMA_BASE_URL",
    });
  });

  test("afterEach restores KEYS after a non-stash resolveMemoryEmbed test", () => {
    for (const key of KEYS) {
      expect(process.env[key]).toBe(originals[key]);
    }
  });
});

describe("applyResolvedEmbedToProcessEnv", () => {
  test("plants OLLAMA defaults when EMBED_MODEL and EMBED_API_STYLE are blank", () => {
    stashEnv();
    process.env["OLLAMA_BASE_URL"] = "http://localhost:9";
    process.env["EMBED_MODEL"] = "";
    process.env["EMBED_API_STYLE"] = "  ";
    const resolved = resolveMemoryEmbed(process.env);
    expect(resolved).toBeDefined();
    if (resolved === undefined) return;
    applyResolvedEmbedToProcessEnv(resolved);
    expect(process.env["EMBED_BASE_URL"]).toBe("http://localhost:9");
    expect(process.env["EMBED_MODEL"]).toBe("nomic-embed-text");
    expect(process.env["EMBED_API_STYLE"]).toBe("ollama");
  });

  test("does not overwrite a non-blank EMBED_MODEL", () => {
    stashEnv();
    process.env["OLLAMA_BASE_URL"] = "http://localhost:9";
    process.env["EMBED_MODEL"] = "custom-embed";
    const resolved = resolveMemoryEmbed(process.env);
    expect(resolved).toBeDefined();
    if (resolved === undefined) return;
    applyResolvedEmbedToProcessEnv(resolved);
    expect(process.env["EMBED_MODEL"]).toBe("custom-embed");
    expect(process.env["EMBED_API_STYLE"]).toBe("ollama");
  });
});

describe("mountMemory", () => {
  test("returns undefined when EMBED_BASE_URL and OLLAMA_BASE_URL are unset (optional)", async () => {
    stashEnv();
    process.env["DATABASE_URL"] = "postgres://localhost:5432/workbench";
    const app = new Hono();
    const handle = await mountMemory({
      app,
      grantStore: createInMemoryGrantStore([]),
      conditionRegistry: {},
    });
    expect(handle).toBeUndefined();
  });

  test("throws when optional is false and EMBED_BASE_URL and OLLAMA_BASE_URL are missing", async () => {
    stashEnv();
    process.env["DATABASE_URL"] = "postgres://localhost:5432/workbench";
    const app = new Hono();
    await expect(
      mountMemory({
        app,
        grantStore: createInMemoryGrantStore([]),
        conditionRegistry: {},
        optional: false,
      }),
    ).rejects.toThrow(/EMBED_BASE_URL or OLLAMA_BASE_URL/);
  });

  test("fails loudly at config parse when EMBED_BASE_URL is set but blank, rather than silently treating it as unset", async () => {
    stashEnv();
    process.env["DATABASE_URL"] = "postgres://localhost:5432/workbench";
    process.env["EMBED_BASE_URL"] = "";
    const app = new Hono();
    await expect(
      mountMemory({
        app,
        grantStore: createInMemoryGrantStore([]),
        conditionRegistry: {},
      }),
    ).rejects.toThrow(/EMBED_BASE_URL/);
  });

  test("throws when RERANK_BASE_URL is set without RERANK_MODEL, rather than reranking silently failing later", async () => {
    stashEnv();
    process.env["DATABASE_URL"] = "postgres://localhost:5432/workbench";
    process.env["EMBED_BASE_URL"] = "http://localhost:9/v1";
    process.env["EMBED_MODEL"] = "test-embedding-model";
    process.env["RERANK_BASE_URL"] = "http://localhost:8080";
    const app = new Hono();
    await expect(
      mountMemory({
        app,
        grantStore: createInMemoryGrantStore([]),
        conditionRegistry: {},
      }),
    ).rejects.toThrow(/RERANK_BASE_URL.*RERANK_MODEL/s);
  });

  test("throws when RERANK_MODEL is set without RERANK_BASE_URL", async () => {
    stashEnv();
    process.env["DATABASE_URL"] = "postgres://localhost:5432/workbench";
    process.env["EMBED_BASE_URL"] = "http://localhost:9/v1";
    process.env["EMBED_MODEL"] = "test-embedding-model";
    process.env["RERANK_MODEL"] = "bge-reranker-v2-m3";
    const app = new Hono();
    await expect(
      mountMemory({
        app,
        grantStore: createInMemoryGrantStore([]),
        conditionRegistry: {},
      }),
    ).rejects.toThrow(/RERANK_BASE_URL.*RERANK_MODEL/s);
  });
});

// DB-gated: skipped when DATABASE_URL is unreachable, matching this repo's
// existing convention for tests that talk to a real Postgres (see
// apps/hub/test/artifact-doc-persistence.test.ts). Proves the actual cutover:
// mounting with only DATABASE_URL (no second memory-plane URL) lands the
// memory engine's tables in its own `memory` schema, never `public`.
const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

describeIfDb("mountMemory: schema isolation against a real database", () => {
  afterAll(async () => {
    const postgres = (await import("postgres")).default;
    const sql = postgres(databaseUrl as string, { max: 1 });
    try {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "memory" CASCADE`);
    } finally {
      await sql.end();
    }
  });

  test("mounts off DATABASE_URL alone and creates tables under `memory`, not `public`", async () => {
    stashEnv();
    process.env["DATABASE_URL"] = databaseUrl;
    process.env["EMBED_BASE_URL"] = "http://localhost:9/v1";
    process.env["EMBED_MODEL"] = "test-embedding-model";

    const app = new Hono();
    const handle = await mountMemory({
      app,
      grantStore: createInMemoryGrantStore([]),
      conditionRegistry: {},
    });
    expect(handle).toBeDefined();

    const postgres = (await import("postgres")).default;
    const sql = postgres(databaseUrl as string, { max: 1 });
    try {
      const memoryTables = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'memory'
      `;
      expect(memoryTables.length).toBeGreaterThan(0);

      const publicLeaks = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('document', 'raw_capture', '_migrations')
      `;
      expect(publicLeaks.length).toBe(0);
    } finally {
      await sql.end();
    }
  });

  test("mounts from OLLAMA_BASE_URL when EMBED_BASE_URL is unset", async () => {
    stashEnv();
    process.env["DATABASE_URL"] = databaseUrl;
    process.env["OLLAMA_BASE_URL"] = "http://localhost:9";

    const handle = await mountMemory({
      app: new Hono(),
      grantStore: createInMemoryGrantStore([]),
      conditionRegistry: {},
    });
    expect(handle).toBeDefined();
    expect(process.env["EMBED_BASE_URL"]).toBe("http://localhost:9");
    expect(process.env["EMBED_MODEL"]).toBe("nomic-embed-text");
    expect(process.env["EMBED_API_STYLE"]).toBe("ollama");
  });
});
