import { describe, expect, test } from "bun:test";

import {
  resolveConfigFromEnv,
  resolveConfigLexicalOnly,
} from "./config-resolution";

const BASE_ENV = { DATABASE_URL: "postgres://localhost:5432/workbench" };

describe("resolveConfigFromEnv", () => {
  test("returns undefined when EMBED_BASE_URL is unset — the next step gets a turn", () => {
    expect(resolveConfigFromEnv(BASE_ENV)).toBeUndefined();
  });

  test("returns undefined when EMBED_BASE_URL is blank", () => {
    expect(
      resolveConfigFromEnv({ ...BASE_ENV, EMBED_BASE_URL: "" }),
    ).toBeUndefined();
  });

  test("builds an embed config when EMBED_BASE_URL and EMBED_MODEL are both set", () => {
    const config = resolveConfigFromEnv({
      ...BASE_ENV,
      EMBED_BASE_URL: "https://api.openai.com/v1",
      EMBED_MODEL: "text-embedding-3-small",
      EMBED_API_KEY: "sk-test",
    });
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
      resolveConfigFromEnv({
        ...BASE_ENV,
        EMBED_BASE_URL: "https://api.openai.com/v1",
      }),
    ).toThrow();
  });

  test("throws when DATABASE_URL is missing", () => {
    expect(() =>
      resolveConfigFromEnv({
        EMBED_BASE_URL: "https://api.openai.com/v1",
        EMBED_MODEL: "text-embedding-3-small",
      }),
    ).toThrow(/DATABASE_URL/);
  });

  test("rerank stays unset when its env vars are absent", () => {
    const config = resolveConfigFromEnv({
      ...BASE_ENV,
      EMBED_BASE_URL: "https://api.openai.com/v1",
      EMBED_MODEL: "text-embedding-3-small",
    });
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
    const config = resolveConfigLexicalOnly(BASE_ENV);
    expect(config.memory.embed).toBeUndefined();
    expect(config.memory.databaseUrl).toBe(BASE_ENV.DATABASE_URL);
  });

  test("throws when DATABASE_URL is missing", () => {
    expect(() => resolveConfigLexicalOnly({})).toThrow(/DATABASE_URL/);
  });
});
