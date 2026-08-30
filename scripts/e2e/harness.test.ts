// Coverage for the cleanup registry every e2e/smoke suite in this
// directory shares (CL-5515): `tempDir` really mkdtemps under the OS
// temp dir with the given prefix, and `track` accepts a spawned app
// without requiring its `stop()` to fire immediately (that only
// happens once the suite's own tests finish, via `afterAll`).

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import {
  createCleanupHarness,
  parseEnvFileDatabaseUrl,
  runCleanups,
  type SpawnedApp,
} from "./harness.ts";

describe("createCleanupHarness", () => {
  test("tempDir mkdtemps a real directory named with its prefix", async () => {
    const { tempDir } = createCleanupHarness();
    const dir = await tempDir("harness-unit-test-");
    expect(existsSync(dir)).toBe(true);
    expect(dir).toContain("harness-unit-test-");
  });

  test("two tempDir calls never collide", async () => {
    const { tempDir } = createCleanupHarness();
    const [first, second] = await Promise.all([
      tempDir("harness-unit-test-"),
      tempDir("harness-unit-test-"),
    ]);
    expect(first).not.toBe(second);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
  });

  test("track accepts a spawned app without calling stop() itself", () => {
    const { track } = createCleanupHarness();
    let stopped = false;
    const app: SpawnedApp = {
      label: "fake",
      output: () => "",
      exited: () => false,
      stop: async () => {
        stopped = true;
      },
    };
    track(app);
    expect(stopped).toBe(false);
  });

  test("a throwing cleanup does not abort the rest; first failure rethrows", async () => {
    const ran: string[] = [];
    const cleanups: (() => Promise<void> | void)[] = [
      () => {
        ran.push("first-registered");
      },
      () => {
        throw new Error("boom");
      },
      () => {
        ran.push("last-registered");
      },
    ];
    await expect(runCleanups(cleanups)).rejects.toThrow("boom");
    expect(ran).toEqual(["last-registered", "first-registered"]);
    expect(cleanups).toHaveLength(0);
  });
});

describe("parseEnvFileDatabaseUrl", () => {
  test("reads DATABASE_URL and ignores comments and blanks", () => {
    expect(
      parseEnvFileDatabaseUrl(
        "# comment\n\nFOO=bar\nDATABASE_URL=postgres://localhost:5432/workbench\n",
      ),
    ).toBe("postgres://localhost:5432/workbench");
  });

  test("strips surrounding quotes and trims", () => {
    expect(
      parseEnvFileDatabaseUrl(
        `  DATABASE_URL="postgres://localhost:5432/workbench"  \n`,
      ),
    ).toBe("postgres://localhost:5432/workbench");
    expect(
      parseEnvFileDatabaseUrl(
        `DATABASE_URL='postgres://localhost:5432/workbench'\n`,
      ),
    ).toBe("postgres://localhost:5432/workbench");
  });

  test("ignores a commented DATABASE_URL and returns undefined when none is set", () => {
    expect(
      parseEnvFileDatabaseUrl("# DATABASE_URL=postgres://commented\nFOO=bar\n"),
    ).toBeUndefined();
  });

  test("last DATABASE_URL wins", () => {
    expect(
      parseEnvFileDatabaseUrl(
        "DATABASE_URL=postgres://first/db\nDATABASE_URL=postgres://second/db\n",
      ),
    ).toBe("postgres://second/db");
  });
});
