import { afterEach, describe, expect, test } from "bun:test";

import { InlineContentStore, type ArtifactDb } from "@corbits/artifacts";

import { mountArtifacts } from "./artifacts-mount";

// URL-resolution tests observe the mount through the injected engine seam
// instead of bun's `mock.module`, whose process-wide registry swap cannot
// be undone for later files in the same `bun test` process (it starved
// test/artifact-doc-persistence.test.ts of the real `createArtifactDb`).
const createArtifactDbCalls: string[] = [];

const stubEngine = {
  createArtifactDb: (databaseUrl: string) => {
    createArtifactDbCalls.push(databaseUrl);
    return { db: {} as ArtifactDb, close: async () => undefined };
  },
  runArtifactMigrations: async () => undefined,
  contentStore: InlineContentStore,
};

const KEYS = ["DATABASE_URL"] as const;
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
    const handle = await mountArtifacts({ engine: stubEngine });
    expect(handle).toBeUndefined();
    expect(createArtifactDbCalls).toEqual([]);
  });

  test("mounts against DATABASE_URL", async () => {
    stashEnv();
    process.env["DATABASE_URL"] = "postgres://localhost:5432/workbench_control";
    const handle = await mountArtifacts({ engine: stubEngine });
    expect(handle).toBeDefined();
    expect(createArtifactDbCalls).toEqual([
      "postgres://localhost:5432/workbench_control",
    ]);
  });

  test("explicit options.databaseUrl wins over DATABASE_URL", async () => {
    stashEnv();
    process.env["DATABASE_URL"] = "postgres://localhost:5432/control";
    const handle = await mountArtifacts({
      databaseUrl: "postgres://localhost:5432/explicit",
      engine: stubEngine,
    });
    expect(handle).toBeDefined();
    expect(createArtifactDbCalls).toEqual([
      "postgres://localhost:5432/explicit",
    ]);
  });
});
