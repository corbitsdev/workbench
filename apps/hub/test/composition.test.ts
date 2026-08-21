// Exercises the hub's own wiring: platform routes answering at boot,
// the echo extension mounted inside the native tenant middleware, and
// same-origin static serving. Platform behavior behind the mounted
// routes belongs to its own packages and is not re-proven here. Booting
// the hub runs package migrations, so a reachable DATABASE_URL is
// required and the suite skips without one.

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HubConfig } from "../src/config.ts";
import { createHub } from "../src/index.ts";

// DB-gated: skipped when DATABASE_URL is unset, matching this repo's
// convention for tests that talk to a real Postgres.
const databaseUrl = process.env["DATABASE_URL"] ?? "";
const describeIfDb = databaseUrl === "" ? describe.skip : describe;

const root = mkdtempSync(path.join(tmpdir(), "hub-composition-"));
const staticDir = path.join(root, "static");
mkdirSync(path.join(staticDir, "assets"), { recursive: true });
writeFileSync(path.join(staticDir, "index.html"), "<html>shell</html>");
writeFileSync(path.join(staticDir, "assets", "app.css"), "body{}");
mkdirSync(path.join(root, "data"), { recursive: true });

const config: HubConfig = {
  databaseUrl,
  baseUrl: "http://localhost:3000",
  sessionSecret: "insecure-test-only-session-secret-0000",
  hubDataDir: path.join(root, "data"),
  hubStaticDir: staticDir,
  signupRateLimit: { windowSeconds: 60, max: 5 },
  signInRateLimit: { windowSeconds: 60, max: 10 },
  socialProviders: {},
  signupMode: "closed",
  allowedEmailDomains: [],
  // No CREDENTIAL_ENCRYPTION_KEY here: this suite never touches the
  // credential-cipher seam, so the dev opt-in keeps boot working.
  allowPlaintextSecrets: true,
  allowUnverifiedEmails: true,
  sidecarProvisioners: [],
  envProviderKeys: {},
  envProviderBaseUrls: {},
  envCredentialPlantAdmin: {
    email: "alice@example.com",
    password: "password123",
    orgSlug: "workbench",
  },
  chatIdleReapMs: 30 * 60_000,
};

const closers: (() => Promise<void>)[] = [];

async function bootHub(): Promise<Awaited<ReturnType<typeof createHub>>> {
  const hub = await createHub(config);
  closers.push(hub.close);
  return hub;
}

afterAll(async () => {
  for (const close of closers) await close();
  rmSync(root, { recursive: true, force: true });
});

describeIfDb("boot", () => {
  test("serves platform health, auth-gated routes, and the interface", async () => {
    const hub = await bootHub();

    const status = await hub.app.request("/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ status: "ok" });

    // The login gate is live: user-scoped platform routes answer 401
    // for an anonymous request instead of 404 or a crash.
    const me = await hub.app.request("/api/me/principals");
    expect(me.status).toBe(401);

    // The interface serves from the same origin: real files as-is,
    // unknown client-side routes as index.html.
    const asset = await hub.app.request("/assets/app.css");
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("body{}");
    const deepLink = await hub.app.request("/settings/profile");
    expect(deepLink.status).toBe(200);
    expect(await deepLink.text()).toBe("<html>shell</html>");

    // Static serving never swallows the API prefix.
    const unknownApi = await hub.app.request("/api/no-such-route");
    expect(unknownApi.status).toBe(404);
  });
});

describeIfDb("shutdown", () => {
  test("close() cancels the pending sidecar allocation reconciliation timer", async () => {
    const setTimeoutSpy = spyOn(global, "setTimeout");
    const clearTimeoutSpy = spyOn(global, "clearTimeout");

    const hub = await createHub(config);
    // index.ts schedules its reconciliation loop with setTimeout(fn,
    // 1000) — the one 1000ms setTimeout call site in the module — so
    // this is the pending timer close() must cancel.
    const reconciliationCallIndex = setTimeoutSpy.mock.calls.findIndex(
      (call) => call[1] === 1000,
    );
    expect(reconciliationCallIndex).toBeGreaterThanOrEqual(0);
    const reconciliationTimerId = setTimeoutSpy.mock.results[
      reconciliationCallIndex
    ]?.value as ReturnType<typeof setTimeout>;

    await hub.close();

    expect(clearTimeoutSpy.mock.calls.map((call) => call[0])).toContain(
      reconciliationTimerId,
    );

    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });
});

describeIfDb("extension mounting", () => {
  test("echo mounts inside the native tenant middleware", async () => {
    const hub = await bootHub();

    // Anonymous request to the echo route: the platform's tenant
    // middleware answers 401 before the extension's handler runs.
    const gated = await hub.app.request("/api/tenants/some-tenant/echo", {
      method: "POST",
      body: "hello",
    });
    expect(gated.status).toBe(401);
    expect(await gated.json()).toEqual({
      error: { code: "unauthorized", message: "Authentication required" },
    });

    // The route exists only under the tenant scope; outside it the
    // path falls through to the interface shell.
    const outside = await hub.app.request("/echo");
    expect(await outside.text()).toBe("<html>shell</html>");
  });

  test("the first-login onboarding hook is gated the same way", async () => {
    const hub = await bootHub();

    const gated = await hub.app.request("/api/onboarding/provision", {
      method: "POST",
    });
    expect(gated.status).toBe(401);
    // Onboarding answers in CL-6360's envelope: a consumer-language
    // `userMessage` and a `refId` that ties the response to the log
    // line, never a raw internal `message`.
    const body = (await gated.json()) as {
      error: { code: string; userMessage: string; refId: string };
    };
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.userMessage).toBe("Sign in to continue.");
    expect(body.error.refId).toMatch(/\S/);
  });

  test("the workbench-tenancy kind lookup the bench switcher uses is mounted and gated", async () => {
    const hub = await bootHub();

    const gated = await hub.app.request("/api/workbench-tenancies/kinds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantIds: [] }),
    });
    expect(gated.status).toBe(401);
    expect(await gated.json()).toEqual({
      error: { code: "unauthorized", message: "Authentication required" },
    });
  });
});

describeIfDb(
  "sign-in rate limiting is keyed on the target account, not client IP (CL-6494)",
  () => {
    // A forged/rotating `x-forwarded-for` is exactly what a caller reaching
    // this hub over Railway's private network (bypassing the edge) can
    // send on every request — the header this suite deliberately varies
    // per attempt below to prove it buys the attacker nothing.
    function signInAttempt(
      hub: Awaited<ReturnType<typeof createHub>>,
      email: string,
      forgedIp: string,
      password = "wrong-password",
    ) {
      return hub.app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": forgedIp,
        },
        body: JSON.stringify({ email, password }),
      });
    }

    async function signUpUser(
      hub: Awaited<ReturnType<typeof createHub>>,
      email: string,
      password: string,
    ) {
      const signUp = await hub.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, name: "Test User" }),
      });
      expect(signUp.status).toBe(200);
    }

    test("a forged, rotating IP header per attempt cannot exceed the per-account budget", async () => {
      const hub = await createHub({
        ...config,
        signInRateLimit: { windowSeconds: 60, max: 2 },
      });
      closers.push(hub.close);

      // Same targeted account, a distinct forged source IP every attempt.
      await signInAttempt(hub, "victim@example.com", "203.0.113.10");
      await signInAttempt(hub, "victim@example.com", "203.0.113.20");
      const throttled = await signInAttempt(
        hub,
        "victim@example.com",
        "203.0.113.30",
      );

      expect(throttled.status).toBe(429);
    });

    test("two genuinely different accounts get independent budgets", async () => {
      const hub = await createHub({
        ...config,
        signInRateLimit: { windowSeconds: 60, max: 1 },
      });
      closers.push(hub.close);

      // Exhausts alice's budget (max: 1), from the same source IP.
      await signInAttempt(hub, "alice@example.com", "203.0.113.40");
      const throttledAlice = await signInAttempt(
        hub,
        "alice@example.com",
        "203.0.113.40",
      );
      expect(throttledAlice.status).toBe(429);

      // bob's very first attempt is untouched by alice's exhausted budget.
      const freshBob = await signInAttempt(
        hub,
        "bob@example.com",
        "203.0.113.40",
      );
      expect(freshBob.status).not.toBe(429);
    });

    test("a rate-limited sign-in carries a retry hint and a human-readable message", async () => {
      const hub = await createHub({
        ...config,
        signInRateLimit: { windowSeconds: 60, max: 1 },
      });
      closers.push(hub.close);

      await signInAttempt(hub, "throttle-me@example.com", "203.0.113.50");
      const throttled = await signInAttempt(
        hub,
        "throttle-me@example.com",
        "203.0.113.60",
      );

      expect(throttled.status).toBe(429);
      expect(throttled.headers.get("retry-after")).not.toBeNull();
      const body = (await throttled.json()) as { message: string };
      expect(body.message).toMatch(/\S/);
    });

    test("an attacker exhausting the account's budget with wrong guesses never blocks the owner's correct password, and a successful sign-in resets the budget", async () => {
      const hub = await createHub({
        ...config,
        signupMode: "open",
        signInRateLimit: { windowSeconds: 60, max: 2 },
      });
      closers.push(hub.close);

      const email = `owner-${crypto.randomUUID()}@example.com`;
      const password = "correct-horse-battery";
      await signUpUser(hub, email, password);

      // Two wrong guesses exhaust the account's failure budget — exactly
      // what an attacker who doesn't know the password sends.
      await signInAttempt(hub, email, "203.0.113.70");
      await signInAttempt(hub, email, "203.0.113.71");
      const thirdWrongGuess = await signInAttempt(hub, email, "203.0.113.72");
      expect(thirdWrongGuess.status).toBe(429);

      // The account owner's correct password still succeeds: only
      // failures ever consume budget, so a correct attempt is never
      // gated on how many wrong guesses came before it.
      const genuineSignIn = await signInAttempt(
        hub,
        email,
        "203.0.113.73",
        password,
      );
      expect(genuineSignIn.status).toBe(200);

      // That success cleared the bucket: the very next wrong guess is a
      // fresh first failure, not an immediate 429 carried over from the
      // attacker's earlier attempts.
      const freshFailureAfterSuccess = await signInAttempt(
        hub,
        email,
        "203.0.113.74",
      );
      expect(freshFailureAfterSuccess.status).not.toBe(429);
    });

    test("malformed sign-in bodies are never rate-limited together and never block a real account", async () => {
      const hub = await createHub({
        ...config,
        signInRateLimit: { windowSeconds: 60, max: 1 },
      });
      closers.push(hub.close);

      // No `email` field at all: doesn't parse, so it never touches the
      // limiter — unrelated malformed requests must not share one bucket.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const malformed = await hub.app.request("/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: "whatever" }),
        });
        expect(malformed.status).not.toBe(429);
      }

      // A real account's first attempt is untouched by the malformed
      // traffic above.
      const fresh = await signInAttempt(
        hub,
        "never-touched@example.com",
        "203.0.113.90",
      );
      expect(fresh.status).not.toBe(429);
    });
  },
);

describeIfDb("dev-mode email verification", () => {
  test("ALLOW_UNVERIFIED_EMAILS auto-verifies a fresh self-serve signup, so it never 403s on the unverified-email gate", async () => {
    const hub = await createHub({
      ...config,
      signupMode: "open",
    });
    closers.push(hub.close);

    const email = `first-run-${crypto.randomUUID()}@example.com`;
    const signUp = await hub.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: "password123",
        name: "New User",
      }),
    });
    expect(signUp.status).toBe(200);
    const body = (await signUp.json()) as { user: { emailVerified: boolean } };
    // No mailer exists anywhere in this stack, so better-auth itself
    // would leave this false forever without the dev-mode auto-verify
    // hook -- this is the exact condition that used to dead-end fresh
    // signup at signup_not_allowed.
    expect(body.user.emailVerified).toBe(true);

    const cookie = signUp.headers.get("set-cookie");
    expect(cookie).not.toBeNull();
    const createTenant = await hub.app.request("/api/tenants", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookie ?? "",
      },
      body: JSON.stringify({
        slug: `bench-${crypto.randomUUID().slice(0, 8)}`,
      }),
    });
    expect(createTenant.status).not.toBe(403);
  });
});
