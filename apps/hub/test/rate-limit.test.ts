// Proves the sign-up rate limit is actually live: better-auth's
// `rateLimit.enabled` defaults to production-only, so without an
// explicit `enabled: true` this limit would be silently inert in dev
// and CI alike. Boots a real hub against a real Postgres and hits
// sign-up past the configured max, asserting the platform's own 429.

import { afterAll, describe, expect, test } from "bun:test";
import {
  bootIsolationHub,
  ISOLATION_SIGNUP_RATE_LIMIT_MAX,
  prepareDatabase,
  resolveDatabaseUrl,
  type AppLike,
} from "../../../test/isolation/setup.ts";

const databaseUrl = resolveDatabaseUrl();

async function signUpAttempt(app: AppLike, email: string): Promise<Response> {
  return app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      name: "Rate Limit Probe",
      password: "rate-limit-suite-pass",
    }),
  });
}

if (!databaseUrl) {
  // Without a database there is nothing meaningful to assert; skipping
  // loudly beats a vacuous pass. Set DATABASE_URL or
  // ISOLATION_DATABASE_URL to run this against a real Postgres. In CI,
  // E2E_REQUIRED=1 turns that skip into a loud failure so this proof can
  // never silently vanish from the pipeline (mirrors scripts/e2e/harness.ts).
  if (process.env["E2E_REQUIRED"] === "1") {
    throw new Error(
      "E2E_REQUIRED=1 but DATABASE_URL is not set; the sign-up rate-limit " +
        "suite would be skipped. Set DATABASE_URL to a reachable Postgres.",
    );
  }
  test.skip("sign-up rate limiting (set DATABASE_URL or ISOLATION_DATABASE_URL to run)", () => {});
} else {
  await prepareDatabase(databaseUrl);
  const hub = await bootIsolationHub(databaseUrl);
  const app: AppLike = hub.app;
  afterAll(async () => {
    await hub.shutdown();
  });

  describe("sign-up rate limiting", () => {
    test("the Nth sign-up past the configured max is rejected with 429", async () => {
      const nonce = Date.now().toString(36);
      // bootIsolationHub's own sidecar-dial-in readiness probe already
      // spent one sign-up against this IP's budget before this test
      // ever runs, so only max - 1 of *this test's* attempts can
      // succeed (each a distinct email so the assertion is about
      // request rate, not colliding accounts) before the limit trips.
      const remainingBudget = ISOLATION_SIGNUP_RATE_LIMIT_MAX - 1;
      const statuses: number[] = [];
      for (let attempt = 0; attempt < remainingBudget + 1; attempt += 1) {
        const response = await signUpAttempt(
          app,
          `rate-limit-${nonce}-${attempt}@isolation.test`,
        );
        statuses.push(response.status);
      }

      expect(statuses.slice(0, remainingBudget)).toEqual(
        new Array(remainingBudget).fill(200),
      );
      expect(statuses[remainingBudget]).toBe(429);
    });
  });
}
