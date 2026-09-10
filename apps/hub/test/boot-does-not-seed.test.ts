// Process-boot proof that hub production boot does not insert product
// state. createHub() never seeded; only `import.meta.main` did, so this
// suite spawns the hub as a real process via startHub rather than
// composing in-process.
//
// DB-gated: boots against its own scratch database so a reachable
// DATABASE_URL is required and the suite skips without one.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

import { setupDatabase } from "../../../scripts/db-setup.ts";
import { dbGate } from "../../../scripts/e2e/db-gate.ts";
import { e2eDatabaseUrl } from "../../../scripts/e2e/database-url.ts";
import {
  api,
  createCleanupHarness,
  expectStatus,
  freePort,
  hop,
  startHub,
} from "../../../scripts/e2e/harness.ts";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const { tempDir, track } = createCleanupHarness();

const ADMIN = { email: "alice@example.com", password: "password123" };

function scratchUrl(): string {
  const url = new URL(databaseUrl ?? "postgres://localhost:5432/unused");
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_boot_does_not_seed`;
  return url.toString();
}

async function withScratchDatabase(
  run: (url: string) => Promise<void>,
): Promise<void> {
  const scratchUrlValue = scratchUrl();
  const maintenanceUrl = new URL(scratchUrlValue);
  maintenanceUrl.pathname = "/postgres";
  const scratchDatabase = new URL(scratchUrlValue).pathname.replace(/^\//, "");
  const maintenance = postgres(maintenanceUrl.toString(), {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    await maintenance.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
  } finally {
    await maintenance.end();
  }
  await setupDatabase(scratchUrlValue);
  try {
    await run(scratchUrlValue);
  } finally {
    const cleanup = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await cleanup.unsafe(
        `DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`,
      );
    } finally {
      await cleanup.end();
    }
  }
}

function namedAssets(data: unknown): { name: string }[] {
  if (!Array.isArray(data)) {
    throw new Error(`expected an asset list, got ${JSON.stringify(data)}`);
  }
  return data.map((row) => {
    if (
      typeof row !== "object" ||
      row === null ||
      typeof row.name !== "string"
    ) {
      throw new Error(
        `expected asset rows with names, got ${JSON.stringify(data)}`,
      );
    }
    return { name: row.name };
  });
}

function skillNames(data: unknown): string[] {
  if (typeof data !== "object" || data === null || !("skills" in data)) {
    throw new Error(`expected { skills }, got ${JSON.stringify(data)}`);
  }
  const skills = (data as { skills: unknown }).skills;
  if (!Array.isArray(skills)) {
    throw new Error(`expected skills array, got ${JSON.stringify(data)}`);
  }
  return skills.map((row) => {
    if (
      typeof row !== "object" ||
      row === null ||
      typeof row.name !== "string"
    ) {
      throw new Error(
        `expected skill rows with names, got ${JSON.stringify(data)}`,
      );
    }
    return row.name;
  });
}

function asList(data: unknown, what: string): unknown[] {
  if (!Array.isArray(data)) {
    throw new Error(`${what}: expected a list, got ${JSON.stringify(data)}`);
  }
  return data;
}

function tenantIdFromPrincipals(data: unknown): string {
  if (typeof data !== "object" || data === null || !("data" in data)) {
    throw new Error(
      `principals: expected { data }, got ${JSON.stringify(data)}`,
    );
  }
  const rows = (data as { data: unknown }).data;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(
      `principals: expected at least one membership, got ${JSON.stringify(data)}`,
    );
  }
  const first = rows[0];
  if (
    typeof first !== "object" ||
    first === null ||
    typeof first.tenantId !== "string"
  ) {
    throw new Error(
      `principals: missing tenantId, got ${JSON.stringify(data)}`,
    );
  }
  return first.tenantId;
}

test("process boot source does not mention the deleted boot seeder", () => {
  const indexSource = readFileSync(
    path.join(import.meta.dir, "../src/index.ts"),
    "utf8",
  );
  expect(indexSource).not.toContain("runSystem" + "Seed");
  expect(indexSource).not.toContain("system" + "-seed");
});

describeIfDb("hub process boot does not seed product state", () => {
  test("process boot inserts no corbits-tools, assistant, skills, or workflow deployments", async () => {
    await withScratchDatabase(async (url) => {
      const dataDir = await tempDir("hub-boot-does-not-seed-");
      const hub = await hop("hub process boot", () =>
        startHub({
          databaseUrl: url,
          port: freePort(),
          sessionSecret: Buffer.from(
            crypto.getRandomValues(new Uint8Array(32)),
          ).toString("hex"),
          dataDir,
        }),
      );
      track(hub);

      const cookies = await hop("sign in as the boot admin", async () => {
        const res = await api(hub.baseUrl, "POST", "/api/auth/sign-in/email", {
          email: ADMIN.email,
          password: ADMIN.password,
        });
        expectStatus("sign-in", res, 200);
        if (res.cookies.length === 0) {
          throw new Error("sign-in returned no session cookie");
        }
        return res.cookies;
      });

      const tenantId = await hop("resolve the root tenant", async () => {
        const res = await api(
          hub.baseUrl,
          "GET",
          "/api/me/principals",
          undefined,
          cookies,
        );
        expectStatus("principals", res, 200);
        return tenantIdFromPrincipals(res.data);
      });

      await hop("no corbits-tools package-registry", async () => {
        const res = await api(
          hub.baseUrl,
          "GET",
          `/api/tenants/${tenantId}/assets?kind=package-registry`,
          undefined,
          cookies,
        );
        expectStatus("list package-registry assets", res, 200);
        expect(namedAssets(res.data).map((a) => a.name)).not.toContain(
          "corbits-tools",
        );
      });

      await hop("no assistant workflow asset", async () => {
        const res = await api(
          hub.baseUrl,
          "GET",
          `/api/tenants/${tenantId}/assets?kind=workflow`,
          undefined,
          cookies,
        );
        expectStatus("list workflow assets", res, 200);
        expect(namedAssets(res.data).map((a) => a.name)).not.toContain(
          "assistant",
        );
      });

      await hop("no skills", async () => {
        const res = await api(
          hub.baseUrl,
          "GET",
          `/api/tenants/${tenantId}/skills`,
          undefined,
          cookies,
        );
        expectStatus("list skills", res, 200);
        expect(skillNames(res.data)).toEqual([]);
      });

      await hop("no workflow deployments", async () => {
        const res = await api(
          hub.baseUrl,
          "GET",
          `/api/tenants/${tenantId}/workflows/deployments`,
          undefined,
          cookies,
        );
        expectStatus("list workflow deployments", res, 200);
        expect(asList(res.data, "deployments")).toEqual([]);
      });
    });
  }, 60_000);
});
