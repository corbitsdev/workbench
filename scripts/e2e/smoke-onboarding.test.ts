// Smoke scenario 2/5 (CL-6004): provisioning. A signed-up user with no
// tenant yet calls the first-login provisioning hook
// (POST /api/onboarding/provision). The e2e hub boots with the
// boot-ensured root tenant present, so under the CL-7578 genesis-or-
// join contract the fresh signup joins that root as a plain member —
// the genesis path (first signup on a truly empty hub mints the root
// itself) is covered in-process by
// `apps/hub/test/signup-genesis.test.ts`. This asserts the join over
// the wire: `kind: "existing-member"` naming the joined root via
// `tenantId`/`tenantSlug` (a plain member gets no wizard — CL-7584
// owns the member UX), and an idempotent re-provision.

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
  "smoke: onboarding provision",
  () => {
    test("a brand-new signup joins the boot root as a member, unseeded", async () => {
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
        "a membership probe joins the boot root as a member",
        async () => {
          const res = await api(
            baseUrl,
            "POST",
            "/api/onboarding/provision",
            undefined,
            cookies,
          );
          expectStatus("provision probe", res, 200);
          const data = res.data as {
            kind: string;
            tenantId: string;
            tenantSlug: string;
            seeded: boolean;
            seedSkipReason?: string;
          };
          expect(data.kind).toBe("existing-member");
          stringField(data, "tenantId", "provision result");
          stringField(data, "tenantSlug", "provision result");
          return data;
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

      await hop("re-provisioning the same account is idempotent", async () => {
        const res = await api(
          baseUrl,
          "POST",
          "/api/onboarding/provision",
          undefined,
          cookies,
        );
        expectStatus("re-provision probe", res, 200);
        const data = res.data as { kind: string };
        expect(data.kind).toBe("existing-member");
      });
    }, 60_000);
  },
);
