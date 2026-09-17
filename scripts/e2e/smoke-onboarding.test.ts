// Smoke scenario 2/5 (CL-6004): first-tenant provisioning. Stock
// Interchange cutover: composition mounts no provisioning hook
// (`POST /api/onboarding/provision` is gone) — signup mints nothing,
// and the first bench comes from an ordinary `POST /api/tenants` with
// a caller-chosen slug, its creator the native owner. This asserts
// that stock flow over the wire: a benchless signup, the mint, and
// the minted root showing up in the creator's own principals.

import { describe, expect, test } from "bun:test";

import { resetSchema, setupDatabase } from "../db-setup.ts";
import {
  api,
  createCleanupHarness,
  e2eDatabaseUrl,
  expectStatus,
  freePort,
  hop,
  startHub,
} from "./harness.ts";

const { tempDir, track } = createCleanupHarness();

const databaseUrl = e2eDatabaseUrl();
if (databaseUrl === undefined) {
  console.warn(
    "smoke-onboarding: DATABASE_URL is not set; suite skipped. Set " +
      "DATABASE_URL (see .env.example) to run it; start Postgres with `docker compose -f compose.test.yml up -d` " +
      "so this skip can never pass silently there.",
  );
}

function stringField(data: unknown, field: string, what: string): string {
  if (typeof data === "object" && data !== null && field in data) {
    const value = (data as Record<string, unknown>)[field];
    if (typeof value === "string" && value !== "") return value;
  }
  throw new Error(`${what}: missing string field "${field}": ${JSON.stringify(data)}`);
}

describe.skipIf(databaseUrl === undefined)("smoke: first-tenant provisioning", () => {
  test("a brand-new signup starts benchless and mints its first tenant via POST /api/tenants", async () => {
    const url = databaseUrl;
    if (url === undefined) throw new Error("unreachable: suite is skipped");

    await hop("database setup", async () => {
      await resetSchema(url);
      await setupDatabase(url);
    });

    const dataDir = await tempDir("e2e-smoke-onboarding-hub-data-");
    const hub = await hop("hub boot", () =>
      startHub({
        databaseUrl: url,
        port: freePort(),
        sessionSecret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"),
        dataDir,
        // The e2e hub carries no hub-owned seed model credential, and
        // the join path never seeds regardless.
      }),
    );
    track(hub);
    const baseUrl = hub.baseUrl;

    const cookies = await hop("sign-up", async () => {
      const res = await api(baseUrl, "POST", "/api/auth/sign-up/email", {
        name: "Onboarding Smoke Tester",
        email: `smoke-onboarding-${crypto.randomUUID()}@example.invalid`,
        password: `pw-${crypto.randomUUID()}`,
      });
      expectStatus("sign-up", res, 200);
      if (res.cookies.length === 0) {
        throw new Error("sign-up returned no session cookie");
      }
      return res.cookies;
    });

    const provisioned = await hop(
      "signup mints nothing — the account starts benchless",
      async () => {
        const probe = await api(baseUrl, "GET", "/api/me/principals", undefined, cookies);
        expectStatus("principals probe", probe, 200);
        const rows = (probe.data as { data: unknown[] }).data;
        expect(rows).toEqual([]);
        return { benchless: true };
      },
    );
    expect(provisioned.benchless).toBe(true);

    const minted = await hop(
      "the first tenant comes from an ordinary POST /api/tenants",
      async () => {
        const slug = `smoke-onboarding-${crypto.randomUUID().slice(0, 8)}`;
        const res = await api(
          baseUrl,
          "POST",
          "/api/tenants",
          { name: "Smoke Onboarding", slug },
          cookies,
        );
        expectStatus("create tenant", res, 201);
        const data = res.data as { id: string; slug?: string };
        const tenantId = stringField(data, "id", "create tenant");
        return { tenantId, tenantSlug: slug };
      },
    );

    await hop("the provisioned bench is a real tenant membership", async () => {
      const res = await api(baseUrl, "GET", "/api/me/principals", undefined, cookies);
      expectStatus("list principals", res, 200);
      const rows = (res.data as { data: { tenantId: string }[] }).data;
      const own = rows.find((row) => row.tenantId === minted.tenantId);
      if (own === undefined) {
        throw new Error(
          `minted tenant ${minted.tenantId} is missing from the caller's own principals: ${JSON.stringify(rows)}`,
        );
      }
    });
  }, 60_000);
});
