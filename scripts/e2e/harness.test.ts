// Coverage for the cleanup registry every e2e/smoke suite in this
// directory shares (CL-5515): `tempDir` really mkdtemps under the OS
// temp dir with the given prefix, and `track` accepts a spawned app
// without requiring its `stop()` to fire immediately (that only
// happens once the suite's own tests finish, via `afterAll`).

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

import { resetSchema, setupDatabase } from "../db-setup.ts";
import {
  createCleanupHarness,
  e2eDatabaseUrl,
  NOOP_CATALOG_MODEL,
  parseEnvFileDatabaseUrl,
  provisionSidecar,
  runCleanups,
  seedNoopCatalogOffering,
  workflowDeployBody,
  type ApiResult,
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

describe("workflowDeployBody", () => {
  test("carries catalog offering ids, never a raw provider/apiKey source", () => {
    const body = workflowDeployBody({
      assetId: "asset-1",
      commitSha: "deadbeef",
      sourceOfferingIds: ["offering-1", "offering-2"],
      defaultSourceOfferingId: "offering-1",
    });
    expect(body).toEqual({
      source: {
        kind: "asset",
        assetId: "asset-1",
        package: { format: "source", commitSha: "deadbeef" },
      },
      entry: (body as { entry: string }).entry,
      sourceOfferingIds: ["offering-1", "offering-2"],
      defaultSourceOfferingId: "offering-1",
    });
    expect(body).not.toHaveProperty("sources");
    expect(body).not.toHaveProperty("defaultSource");
  });
});

describe("seedNoopCatalogOffering", () => {
  // CL-7473: a suite's workflow definition must declare its inference
  // preference as `("anthropic", NOOP_CATALOG_MODEL)` to match what this
  // helper plants — the deploy-time capability walk only auto-approves the
  // (provider, model) pair a step's own agent declares, so a preference
  // naming any other model 409s "no approved inference source" at deploy
  // even though the suite never calls real inference. This pins the
  // catalog-model creation call's `canonicalName` to the exported constant
  // so the two can never drift apart silently again.
  test("plants a catalog model named NOOP_CATALOG_MODEL", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const call = async (
      _method: string,
      path: string,
      body?: unknown,
    ): Promise<ApiResult> => {
      calls.push({ path, body });
      if (path.endsWith("/catalog/models")) {
        return { status: 201, data: { id: "model-1" }, cookies: [] };
      }
      if (path.endsWith("/providers")) {
        return { status: 201, data: { id: "provider-1" }, cookies: [] };
      }
      if (path.endsWith("/credentials")) {
        return { status: 201, data: { id: "credential-1" }, cookies: [] };
      }
      if (path.endsWith("/catalog/providers")) {
        return {
          status: 201,
          data: { id: "catalog-provider-1" },
          cookies: [],
        };
      }
      return { status: 201, data: { id: "offering-1" }, cookies: [] };
    };

    await seedNoopCatalogOffering({
      call,
      tenantId: "tenant-1",
      cookies: [],
      noopBaseUrl: "https://inference.invalid",
    });

    const modelCall = calls.find((entry) =>
      entry.path.endsWith("/catalog/models"),
    );
    expect(modelCall?.body).toEqual({ canonicalName: NOOP_CATALOG_MODEL });
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

// CL-7472 regression: at pin 692c3106, the hub authenticates a
// sidecar's register/reconnect frame only against a `sidecar` row that
// resolves to a live `sidecar_allocation` (or `workflow_probe`) row —
// upstream dropped the older "shared" credential scope this repo used
// to provision a single, standalone sidecar identity for (see
// `provisionSidecar`'s own doc comment). CI's e2e suites hit exactly
// this: a `provisionSidecar`-only row connects and is rejected with
// "invalid token" in a loop (never a working dial-in), which is why
// every suite now lets the hub's own process-provisioner spawn a
// dedicated, already-allocated sidecar per deployment instead (see
// `startHub`'s doc comment). This test pins the negative: an
// unallocated identity must keep failing to authenticate, so a future
// upstream re-vendor that silently restores (or a caller that
// silently starts relying on) the old "shared" scope surfaces here
// first rather than as a mystery disconnect loop in CI.
describe("provisionSidecar", () => {
  const databaseUrl = e2eDatabaseUrl();
  const HUB_DIR = path.resolve(import.meta.dir, "..", "..", "apps", "hub");

  test.skipIf(databaseUrl === undefined)(
    "a provisioned identity with no allocation or probe never authenticates",
    async () => {
      const url = databaseUrl;
      if (url === undefined) throw new Error("unreachable: suite is skipped");

      await resetSchema(url);
      await setupDatabase(url);

      const sidecarId = "harness-test-unallocated-sidecar";
      const token = crypto.randomUUID();
      await provisionSidecar(url, sidecarId, token);

      // Resolved through the hub's own dependency tree, exactly as
      // `connectE2eDb` resolves `postgres` above — scripts/e2e is not
      // itself a workspace member of these `@intx/*` packages.
      const dbModule = (await import(
        Bun.resolveSync("@intx/db", HUB_DIR)
      )) as { createDB: (raw: unknown) => { db: unknown; close: () => Promise<void> } };
      const hubSessionsModule = (await import(
        Bun.resolveSync("@intx/hub-sessions", HUB_DIR)
      )) as {
        createSidecarCredentialResolver: (deps: { db: unknown }) => {
          resolve: (token: string) => Promise<unknown>;
        };
      };

      const parsed = new URL(url);
      const db = dbModule.createDB({
        host: parsed.hostname,
        port: parsed.port === "" ? 5432 : Number(parsed.port),
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
        database: parsed.pathname.replace(/^\//, ""),
      });
      try {
        const resolver = hubSessionsModule.createSidecarCredentialResolver({
          db: db.db,
        });
        const identity = await resolver.resolve(token);
        expect(identity).toBeNull();
      } finally {
        await db.close();
      }
    },
    60_000,
  );
});
