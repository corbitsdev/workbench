import { describe, expect, test } from "bun:test";
import type { MemoryConfig } from "@corbits/memory";

import {
  buildMemoryPlaneStatus,
  hostOnly,
  MEMORY_SETUP_OPTIONS,
} from "./memory-status";

const baseConfig: MemoryConfig = {
  memory: {
    databaseUrl: "postgres://localhost:5432/workbench",
    dbPoolMax: 8,
    ftsLanguage: "english",
    rerank: {
      baseUrl: undefined,
      model: undefined,
      apiKey: undefined,
      maxDocChars: undefined,
      timeoutMs: undefined,
    },
  },
};

const degrade = {
  tenantId: "tnt_1",
  totalSearches: 12,
  degradeCounts: {
    dense_unavailable: 0,
    rerank_unavailable: 0,
    rerank_query_too_long: 0,
    live_timeout: 0,
    live_error: 0,
    memory_unavailable: 0,
    lexical_only: 0,
  },
  since: new Date("2026-08-01T00:00:00.000Z"),
  windowSize: 12,
  windowedDegradeRate: {
    dense_unavailable: 0,
    rerank_unavailable: 0,
    rerank_query_too_long: 0,
    live_timeout: 0,
    live_error: 0,
    memory_unavailable: 0,
    lexical_only: 0,
  },
  escalated: {
    dense_unavailable: false,
    rerank_unavailable: false,
    rerank_query_too_long: false,
    live_timeout: false,
    live_error: false,
    memory_unavailable: false,
    lexical_only: false,
  },
};

describe("hostOnly", () => {
  test("extracts just the host, dropping path/query — never a full URL that could carry a credential", () => {
    expect(hostOnly("https://api.openai.com/v1?key=secret")).toBe(
      "api.openai.com",
    );
  });

  test("falls back to the raw string for something that isn't a real URL", () => {
    expect(hostOnly("not-a-url")).toBe("not-a-url");
  });
});

describe("MEMORY_SETUP_OPTIONS", () => {
  test("includes lexical-only as a real, honest option — not framed as needing no setup at all", () => {
    const lexicalOnly = MEMORY_SETUP_OPTIONS.find(
      (option) => option.kind === "lexical-only",
    );
    expect(lexicalOnly).toBeDefined();
    expect(lexicalOnly?.kind === "lexical-only" && lexicalOnly.caveat).toMatch(
      /pgvector/,
    );
  });
});

describe("buildMemoryPlaneStatus", () => {
  test("reports embeddingsConfigured from Memory.capabilities, not from config presence", () => {
    const status = buildMemoryPlaneStatus(
      "lexical-only",
      baseConfig,
      { embeddingsConfigured: false },
      degrade,
    );
    expect(status.embeddingsConfigured).toBe(false);
    expect(status.embed).toBeNull();
    expect(status.missing).toHaveLength(1);
    expect(status.setupOptions).toEqual(MEMORY_SETUP_OPTIONS);
  });

  test("reports a dense embed host/model and no missing setup when embeddings are configured", () => {
    const config: MemoryConfig = {
      memory: {
        ...baseConfig.memory,
        embed: {
          baseUrl: "https://api.openai.com/v1",
          model: "text-embedding-3-small",
          apiStyle: "openai",
          apiKey: "sk-test",
          timeoutMs: undefined,
        },
      },
    };
    const status = buildMemoryPlaneStatus(
      "connected-credential",
      config,
      { embeddingsConfigured: true },
      degrade,
    );
    expect(status.embed).toEqual({
      model: "text-embedding-3-small",
      host: "api.openai.com",
    });
    expect(status.missing).toEqual([]);
    expect(status.setupOptions).toEqual([]);
  });

  test("never leaks the rerank API key or full URL, only host + model", () => {
    const config: MemoryConfig = {
      memory: {
        ...baseConfig.memory,
        rerank: {
          baseUrl: "https://rerank.example.com/v1?token=shh",
          model: "rerank-v1",
          apiKey: "shh-rerank-key",
          maxDocChars: undefined,
          timeoutMs: undefined,
        },
      },
    };
    const status = buildMemoryPlaneStatus(
      "lexical-only",
      config,
      { embeddingsConfigured: false },
      degrade,
    );
    expect(status.rerank).toEqual({
      configured: true,
      model: "rerank-v1",
      host: "rerank.example.com",
    });
    expect(JSON.stringify(status)).not.toContain("shh");
  });
});
