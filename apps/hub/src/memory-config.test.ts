import { describe, expect, test } from "bun:test";

import {
  resolveConfigFromEnv,
  resolveConfigLexicalOnly,
  resolveMemoryConfig,
} from "./memory-config";

const DATABASE_URL = "postgres://localhost:5432/workbench";

describe("resolveConfigFromEnv", () => {
  test("returns undefined when EMBED_BASE_URL is unset — the lexical-only floor applies", () => {
    expect(resolveConfigFromEnv({}, DATABASE_URL)).toBeUndefined();
  });

  test("returns undefined when EMBED_BASE_URL is blank", () => {
    expect(
      resolveConfigFromEnv({ EMBED_BASE_URL: "" }, DATABASE_URL),
    ).toBeUndefined();
  });

  test("builds an embed config when EMBED_BASE_URL and EMBED_MODEL are both set", () => {
    const config = resolveConfigFromEnv(
      {
        EMBED_BASE_URL: "https://api.openai.com/v1",
        EMBED_MODEL: "text-embedding-3-small",
        EMBED_API_KEY: "sk-test",
      },
      DATABASE_URL,
    );
    expect(config?.memory.embed).toEqual({
      baseUrl: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
      apiStyle: "openai",
      apiKey: "sk-test",
      timeoutMs: undefined,
    });
  });

  test("throws when EMBED_BASE_URL is set but EMBED_MODEL is missing — a real operator mistake, never silently skipped", () => {
    expect(() =>
      resolveConfigFromEnv(
        { EMBED_BASE_URL: "https://api.openai.com/v1" },
        DATABASE_URL,
      ),
    ).toThrow();
  });

  test("throws when databaseUrl is empty", () => {
    expect(() =>
      resolveConfigFromEnv(
        {
          EMBED_BASE_URL: "https://api.openai.com/v1",
          EMBED_MODEL: "text-embedding-3-small",
        },
        "",
      ),
    ).toThrow(/DATABASE_URL/);
  });

  test("rerank stays unset when its env vars are absent", () => {
    const config = resolveConfigFromEnv(
      {
        EMBED_BASE_URL: "https://api.openai.com/v1",
        EMBED_MODEL: "text-embedding-3-small",
      },
      DATABASE_URL,
    );
    expect(config?.memory.rerank).toEqual({
      baseUrl: undefined,
      model: undefined,
      apiKey: undefined,
      maxDocChars: undefined,
      timeoutMs: undefined,
    });
  });
});

describe("resolveConfigLexicalOnly", () => {
  test("omits embed entirely — the floor needs nothing beyond DATABASE_URL", () => {
    const config = resolveConfigLexicalOnly({}, DATABASE_URL);
    expect(config.memory.embed).toBeUndefined();
    expect(config.memory.databaseUrl).toBe(DATABASE_URL);
  });

  test("throws when databaseUrl is empty", () => {
    expect(() => resolveConfigLexicalOnly({}, "")).toThrow(/DATABASE_URL/);
  });
});

describe("resolveMemoryConfig", () => {
  test("source is 'env' when EMBED_BASE_URL is set — a pure, synchronous decision", () => {
    const resolution = resolveMemoryConfig({
      env: {
        EMBED_BASE_URL: "https://api.openai.com/v1",
        EMBED_MODEL: "text-embedding-3-small",
      },
      databaseUrl: DATABASE_URL,
    });
    expect(resolution.source).toBe("env");
    expect(resolution.config.memory.embed?.model).toBe(
      "text-embedding-3-small",
    );
  });

  test("source is 'lexical-only' when no embed endpoint is configured — the only other state", () => {
    const resolution = resolveMemoryConfig({
      env: {},
      databaseUrl: DATABASE_URL,
    });
    expect(resolution.source).toBe("lexical-only");
    expect(resolution.config.memory.embed).toBeUndefined();
  });
});
