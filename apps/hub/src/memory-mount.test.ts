import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { mountMemory } from "./memory-mount";

const KEYS = [
  "KNOWLEDGE_DATABASE_URL",
  "EMBED_BASE_URL",
  "EMBED_MODEL",
  "EMBED_API_STYLE",
  "EMBED_API_KEY",
] as const;

type EnvKey = (typeof KEYS)[number];

const saved: Partial<Record<EnvKey, string | undefined>> = {};

function clearEnvKey(key: EnvKey): void {
  // Prefer assignment over `delete process.env[key]` — eslint forbids dynamic delete.
  process.env[key] = undefined;
}

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) clearEnvKey(key);
    else process.env[key] = value;
    saved[key] = undefined;
  }
});

function stashEnv(): void {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    clearEnvKey(key);
  }
}

describe("mountMemory", () => {
  test("returns undefined when KNOWLEDGE_DATABASE_URL is unset (optional)", () => {
    stashEnv();
    const app = new Hono();
    const handle = mountMemory({
      app,
      grantStore: {} as never,
      conditionRegistry: {},
    });
    expect(handle).toBeUndefined();
  });

  test("throws when optional is false and env is missing", () => {
    stashEnv();
    const app = new Hono();
    expect(() =>
      mountMemory({
        app,
        grantStore: {} as never,
        conditionRegistry: {},
        optional: false,
      }),
    ).toThrow(/KNOWLEDGE_DATABASE_URL/);
  });
});
