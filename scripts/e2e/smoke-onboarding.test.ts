// Smoke scenario 2/5 (CL-6004): provisioning. A signed-up user with no
// tenant yet calls the first-login provisioning hook
// (POST /api/onboarding/provision); it mints a personal bench through
// the native tenant-creation route. The e2e hub never carries
// ANTHROPIC_API_KEY, so no hub-owned seed model credential is
// configured — this asserts that documented, typed condition of the
// response contract (`seeded: false` with a `seedSkipReason`) rather
// than exercising full default-workflow seeding, which needs a real
// inference credential this suite deliberately never has.

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
      "DATABASE_URL (see .env.example) to run it; CI sets E2E_REQUIRED=1 " +
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
    test("provisioning a personal bench without a seed model reports bench_unseeded", async () => {
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
          // Deliberately no ANTHROPIC_API_KEY: the hub carries no
          // hub-owned seed model credential, so provisioning must
          // report the bench as provisioned-but-unseeded.
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

      await hop(
        "a membership probe before naming reports needs-onboarding",
        async () => {
          const res = await api(
            baseUrl,
            "POST",
            "/api/onboarding/provision",
            undefined,
            cookies,
          );
          expectStatus("provision probe", res, 200);
          expect((res.data as { kind: string }).kind).toBe("needs-onboarding");
        },
      );

      const provisioned = await hop(
        "provisioning with a display name mints a personal bench, unseeded",
        async () => {
          const res = await api(
            baseUrl,
            "POST",
            "/api/onboarding/provision",
            { name: "Onboarding Smoke Tester's Bench" },
            cookies,
          );
          expectStatus("provision", res, 200);
          const data = res.data as {
            kind: string;
            tenantId: string;
            tenantSlug: string;
            seeded: boolean;
            seedSkipReason?: string;
          };
          expect(data.kind).toBe("provisioned");
          expect(data.seeded).toBe(false);
          expect(typeof data.seedSkipReason).toBe("string");
          expect(data.seedSkipReason).not.toBe("");
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
