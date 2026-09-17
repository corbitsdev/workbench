// Smoke scenario 2/5 (CL-6004): provisioning. A signed-up user with no
// tenant yet performs client convergence
// (POST /api/tenants). The e2e hub boots empty, so under the CL-8085
// client-convergence contract the first signup creates the root itself
// and becomes owner — the same path covered in-process by
// `apps/hub/test/signup-genesis.test.ts`. This asserts convergence over
// the wire: a 201 naming the created root via `id`, a real tenant
// membership for the creator, and a re-create of the same slug
// conflicting instead of minting a duplicate.

import { describe, test } from "bun:test";

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
      "DATABASE_URL (see .env.example) to run it; start Postgres with `docker compose -f docker-compose.test.yml up -d` " +
      "so this skip can never pass silently there.",
  );
}

function stringField(data: unknown, field: string, what: string): string {
  if (typeof data === "object" && data !== null && field in data) {
    const value = (data as Record<string, unknown>)[field];
    if (typeof value === "string" && value !== "") return value;
  }
  throw new Error(
    `${what}: missing string field "${field}": ${JSON.stringify(data)}`,
  );
}

describe.skipIf(databaseUrl === undefined)(
  "smoke: onboarding convergence",
  () => {
    test("a brand-new signup creates the root as owner, unseeded", async () => {
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
          sessionSecret: Buffer.from(
            crypto.getRandomValues(new Uint8Array(32)),
          ).toString("hex"),
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
        "the first signup creates the root as owner",
        async () => {
          const slug = `smoke-onboarding-${crypto.randomUUID().slice(0, 8)}`;
          const res = await api(
            baseUrl,
            "POST",
            "/api/tenants",
            { name: "Smoke Onboarding", slug },
            cookies,
          );
          expectStatus("create root tenant", res, 201);
          const tenantId = stringField(res.data, "id", "create tenant");
          return { tenantId, tenantSlug: slug };
        },
      );

      await hop(
        "the provisioned bench is a real tenant membership",
        async () => {
          const res = await api(
            baseUrl,
            "GET",
            "/api/me/principals",
            undefined,
            cookies,
          );
          expectStatus("list principals", res, 200);
          const rows = (res.data as { data: { tenantId: string }[] }).data;
          const own = rows.find((row) => row.tenantId === provisioned.tenantId);
          if (own === undefined) {
            throw new Error(
              `provisioned tenant ${provisioned.tenantId} is missing from the caller's own principals: ${JSON.stringify(rows)}`,
            );
          }
        },
      );

      await hop("re-creating the same slug conflicts outright", async () => {
        const res = await api(
          baseUrl,
          "POST",
          "/api/tenants",
          { name: "Smoke Onboarding", slug: provisioned.tenantSlug },
          cookies,
        );
        expectStatus("re-create root tenant", res, 409);
      });
    }, 60_000);
  },
);
