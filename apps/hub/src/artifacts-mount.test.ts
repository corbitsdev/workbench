import { afterEach, describe, expect, mock, test } from "bun:test";

// `mock.module` replaces the module in bun's process-wide registry, so
// every export must be preserved here — not just the three this file
// overrides. Dropping the rest (as a bare replacement literal would)
// starves any test file that runs later in the same `bun test` process
// and imports `@corbits/artifacts` for its other exports (e.g.
// `createFileArtifact` via `@corbits/artifacts-hub`).
const actualArtifacts = await import("@corbits/artifacts");

// Capture the URL `createArtifactDb` is called with so we can assert
// resolution order without talking to Postgres.
const createArtifactDbCalls: string[] = [];

mock.module("@corbits/artifacts", () => ({
  ...actualArtifacts,
  createArtifactDb: (databaseUrl: string) => {
    createArtifactDbCalls.push(databaseUrl);
    return { db: {} };
  },
  runArtifactMigrations: async () => undefined,
  InlineContentStore: {},
}));

const { mountArtifacts } = await import("./artifacts-mount");

const KEYS = ["ARTIFACTS_DATABASE_URL", "DATABASE_URL"] as const;
type EnvKey = (typeof KEYS)[number];
const saved: Partial<Record<EnvKey, string | undefined>> = {};

function clearEnvKey(key: EnvKey): void {
  process.env[key] = undefined;
}

function stashEnv(): void {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    clearEnvKey(key);
  }
  createArtifactDbCalls.length = 0;
}

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) clearEnvKey(key);
    else process.env[key] = value;
    saved[key] = undefined;
  }
  createArtifactDbCalls.length = 0;
});

describe("mountArtifacts URL resolution", () => {
  test("returns undefined when no URL is available", async () => {
    stashEnv();
    const handle = await mountArtifacts();
    expect(handle).toBeUndefined();
    expect(createArtifactDbCalls).toEqual([]);
  });

  test("falls back to DATABASE_URL when ARTIFACTS_DATABASE_URL is unset", async () => {
    stashEnv();
    process.env["DATABASE_URL"] = "postgres://localhost:5432/workbench_control";
    const handle = await mountArtifacts();
    expect(handle).toBeDefined();
    expect(createArtifactDbCalls).toEqual([
      "postgres://localhost:5432/workbench_control",
    ]);
  });

  test("prefers ARTIFACTS_DATABASE_URL over DATABASE_URL", async () => {
    stashEnv();
    process.env["DATABASE_URL"] = "postgres://localhost:5432/control";
    process.env["ARTIFACTS_DATABASE_URL"] =
      "postgres://localhost:5432/artifacts_pin";
    const handle = await mountArtifacts();
    expect(handle).toBeDefined();
    expect(createArtifactDbCalls).toEqual([
      "postgres://localhost:5432/artifacts_pin",
    ]);
  });

  test("explicit options.databaseUrl wins over both env vars", async () => {
    stashEnv();
    process.env["DATABASE_URL"] = "postgres://localhost:5432/control";
    process.env["ARTIFACTS_DATABASE_URL"] =
      "postgres://localhost:5432/artifacts_pin";
    const handle = await mountArtifacts({
      databaseUrl: "postgres://localhost:5432/explicit",
    });
    expect(handle).toBeDefined();
    expect(createArtifactDbCalls).toEqual([
      "postgres://localhost:5432/explicit",
    ]);
  });
});
