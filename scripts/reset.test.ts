// Unit gates for scripts/reset.ts's own logic: the local-database
// guard, on-disk directory resolution, and the orchestration in
// resetLocalState. The schema drop itself is @intx/db's dropSchema,
// already exercised through resetSchema in scripts/e2e/db-setup.test.ts;
// here resetSchema is a test double so this suite runs without Postgres.

import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  requireLocalDatabase,
  resetLocalState,
  resolveLocalStateDirs,
  type ResetDeps,
} from "./reset.ts";

const VALID_ENV = {
  DATABASE_URL: "postgres://localhost:5432/workbench",
  BASE_URL: "http://localhost:3000",
  SESSION_SECRET: "a".repeat(32),
  HUB_DATA_DIR: ".data/hub",
  HUB_STATIC_DIR: "../web/dist",
};

describe("requireLocalDatabase", () => {
  for (const hostname of ["localhost", "127.0.0.1", "::1"]) {
    test(`accepts ${hostname}`, () => {
      expect(() =>
        requireLocalDatabase(
          `postgres://${hostname === "::1" ? "[::1]" : hostname}:5432/workbench`,
        ),
      ).not.toThrow();
    });
  }

  test("refuses a remote host", () => {
    expect(() =>
      requireLocalDatabase("postgres://prod.example.com:5432/workbench"),
    ).toThrow(/not local/);
  });
});

describe("resolveLocalStateDirs", () => {
  test("resolves the hub dir against apps/hub and the sidecar dir at the repo root", () => {
    const dirs = resolveLocalStateDirs("/repo", ".data/hub");
    expect(dirs.hubDataDir).toBe(path.resolve("/repo/apps/hub/.data/hub"));
    expect(dirs.sidecarDataDir).toBe(path.resolve("/repo/.data/sidecar"));
  });

  test("honors an absolute HUB_DATA_DIR", () => {
    const dirs = resolveLocalStateDirs("/repo", "/var/workbench-data");
    expect(dirs.hubDataDir).toBe("/var/workbench-data");
  });
});

describe("resetLocalState", () => {
  test("refuses a non-local DATABASE_URL before touching anything", async () => {
    let resetSchemaCalls = 0;
    const deps: ResetDeps = {
      root: "/repo",
      resetSchema: async () => {
        resetSchemaCalls += 1;
      },
      rm: async () => undefined,
      exists: () => true,
    };
    await expect(
      resetLocalState(
        { ...VALID_ENV, DATABASE_URL: "postgres://prod.example.com/workbench" },
        deps,
      ),
    ).rejects.toThrow(/not local/);
    expect(resetSchemaCalls).toBe(0);
  });

  test("drops the schema and removes only the directories that exist", async () => {
    const schemaCalls: string[] = [];
    const removed: string[] = [];
    const present = new Set([path.resolve("/repo/apps/hub/.data/hub")]);
    const deps: ResetDeps = {
      root: "/repo",
      resetSchema: async (databaseUrl) => {
        schemaCalls.push(databaseUrl);
      },
      rm: async (dir) => {
        removed.push(String(dir));
      },
      exists: (dir) => present.has(String(dir)),
    };

    const report = await resetLocalState(VALID_ENV, deps);

    expect(schemaCalls).toEqual([VALID_ENV.DATABASE_URL]);
    expect(removed).toEqual([path.resolve("/repo/apps/hub/.data/hub")]);
    expect(report.database).toBe("workbench");
    expect(report.removedDirs).toEqual([
      path.resolve("/repo/apps/hub/.data/hub"),
    ]);
  });

  test("reports no removed directories when neither is present", async () => {
    const deps: ResetDeps = {
      root: "/repo",
      resetSchema: async () => undefined,
      rm: async () => undefined,
      exists: () => false,
    };
    const report = await resetLocalState(VALID_ENV, deps);
    expect(report.removedDirs).toEqual([]);
  });
});
