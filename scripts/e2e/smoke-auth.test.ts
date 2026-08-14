// Smoke scenario 1/5 (CL-6004): sign-up + session. The narrowest proof
// in the suite — a real hub process, a real better-auth email sign-up,
// and the resulting session cookie actually authorizing a session-gated
// route. No tenant, no sidecar: this only proves the auth boundary
// itself, which every other smoke scenario in this directory builds on.

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
    "smoke-auth: DATABASE_URL is not set; suite skipped. Set DATABASE_URL " +
      "(see .env.example) to run it; CI sets E2E_REQUIRED=1 so this skip " +
      "can never pass silently there.",
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

describe.skipIf(databaseUrl === undefined)("smoke: sign-up and session", () => {
  test("email sign-up mints a session cookie that authorizes a session-gated route", async () => {
    const url = databaseUrl;
    if (url === undefined) throw new Error("unreachable: suite is skipped");

    await hop("database setup", async () => {
      await resetSchema(url);
      await setupDatabase(url);
    });

    const dataDir = await tempDir("e2e-smoke-auth-hub-data-");
    const hub = await hop("hub boot", () =>
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
    const baseUrl = hub.baseUrl;

    const email = `smoke-auth-${crypto.randomUUID()}@example.invalid`;
    const password = `pw-${crypto.randomUUID()}`;

    await hop(
      "anonymous call to a session-gated route is rejected",
      async () => {
        const res = await api(baseUrl, "GET", "/api/me/principals");
        expectStatus("anonymous /api/me/principals", res, 401);
      },
    );

    const cookies = await hop("sign-up", async () => {
      const res = await api(baseUrl, "POST", "/api/auth/sign-up/email", {
        name: "Smoke Auth Tester",
        email,
        password,
      });
      expectStatus("sign-up", res, 200);
      if (res.cookies.length === 0) {
        throw new Error("sign-up returned no session cookie");
      }
      return res.cookies;
    });

    await hop("session cookie authorizes a session-gated route", async () => {
      const res = await api(
        baseUrl,
        "GET",
        "/api/me/principals",
        undefined,
        cookies,
      );
      expectStatus("authenticated /api/me/principals", res, 200);
      const body = res.data as { data: unknown[] };
      expect(Array.isArray(body.data)).toBe(true);
      // A brand-new account belongs to no tenant yet.
      expect(body.data.length).toBe(0);
    });

    await hop(
      "sign-in with the same credentials also mints a session",
      async () => {
        const res = await api(baseUrl, "POST", "/api/auth/sign-in/email", {
          email,
          password,
        });
        expectStatus("sign-in", res, 200);
        if (res.cookies.length === 0) {
          throw new Error("sign-in returned no session cookie");
        }
        stringField(
          (res.data as { user: unknown }).user,
          "id",
          "sign-in user field",
        );
      },
    );
  }, 60_000);
});
