// The retry-until-resolved scheduling `scheduleEnvProviderCredentialPlant`
// owns: finding the operator bench (sign in as the admin, resolve its
// slug) and, once found, running the plant exactly once. The actual
// planting is `@workbench/onboarding`'s own, thoroughly tested
// `plantEnvProviderCredentials` — these tests fake it out (the `plant`
// seam) so they only prove this module's own job: sign in (never sign
// up), resolve, then hand off, retrying quietly when the bench does not
// exist yet.

import { afterEach, describe, expect, test } from "bun:test";
import { scheduleEnvProviderCredentialPlant } from "../src/env-credential-plant.ts";

const BASE_URL = "http://hub.test";
const ADMIN = {
  email: "alice@example.com",
  password: "password123",
  orgSlug: "workbench",
};

type FakeState = {
  principals: { tenantId: string; tenantSlug: string; principalId: string }[];
  signInOk: boolean;
  /** Flips true only if the fake ever answers a sign-in call with a
   * fresh cookie value, so a re-auth-on-401 test can tell a cached
   * session apart from a freshly minted one. */
  signInCount: number;
  signUpCalled: boolean;
  /** When true, `/api/me/principals` answers 401 once (simulating a
   * stale/expired session cookie) before answering normally. */
  unauthorizeOnce: boolean;
};

function principalsBody(rows: FakeState["principals"]) {
  return {
    data: rows.map((r) => ({
      principalId: r.principalId,
      tenantId: r.tenantId,
      tenantName: r.tenantSlug,
      tenantSlug: r.tenantSlug,
      kind: "user",
      status: "active",
      roles: [],
    })),
    nextCursor: null,
  };
}

function json(body: unknown, status = 200, cookie = "session=abc"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "set-cookie": cookie },
  });
}

function fakeFetch(state: FakeState): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/auth/sign-in/email") {
      if (!state.signInOk) return json({ error: "invalid_credentials" }, 401);
      state.signInCount += 1;
      return json(
        { user: { id: "usr_admin" } },
        200,
        `session=abc${state.signInCount}`,
      );
    }
    // Answering 200 here (instead of throwing on an "unexpected path")
    // is deliberate: a fake that throws on sign-up hides the bug this
    // suite exists to catch — a sign-in-only implementation must never
    // reach this branch at all, proven by `signUpCalled` below, not by
    // this fake refusing to answer.
    if (url.pathname === "/api/auth/sign-up/email") {
      state.signUpCalled = true;
      return json({ user: { id: "usr_admin_signed_up" } });
    }
    if (url.pathname === "/api/me/principals") {
      if (state.unauthorizeOnce) {
        state.unauthorizeOnce = false;
        return json({ error: "unauthorized" }, 401);
      }
      return json(principalsBody(state.principals));
    }
    throw new Error(`fake fetch: unexpected path ${url.pathname}`);
  };
}

const handles: { stop: () => void }[] = [];
afterEach(() => {
  for (const handle of handles) handle.stop();
  handles.length = 0;
});

describe("scheduleEnvProviderCredentialPlant", () => {
  test("no provider keys: never calls fetch or plant", async () => {
    let fetchCalled = false;
    let plantCalled = false;
    const handle = scheduleEnvProviderCredentialPlant({
      baseUrl: BASE_URL,
      envProviderKeys: {},
      envProviderBaseUrls: {},
      admin: ADMIN,
      fetch: async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      },
      plant: async () => {
        plantCalled = true;
        return [];
      },
    });
    handles.push(handle);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchCalled).toBe(false);
    expect(plantCalled).toBe(false);
  });

  test("the operator bench already exists: plants once immediately, no retries", async () => {
    const state: FakeState = {
      signInOk: true,
      signInCount: 0,
      signUpCalled: false,
      unauthorizeOnce: false,
      principals: [
        {
          tenantId: "ten_operator",
          tenantSlug: "workbench",
          principalId: "prn_admin",
        },
      ],
    };
    let plantCalls = 0;
    let seenTenantId: string | undefined;
    const handle = scheduleEnvProviderCredentialPlant({
      baseUrl: BASE_URL,
      envProviderKeys: { anthropic: "sk-ant-test" },
      envProviderBaseUrls: {},
      admin: ADMIN,
      retryIntervalMs: 10,
      fetch: fakeFetch(state),
      plant: async (args: { tenantId: string }) => {
        plantCalls += 1;
        seenTenantId = args.tenantId;
        return [{ provider: "anthropic" as const, status: "planted" as const }];
      },
    });
    handles.push(handle);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(plantCalls).toBe(1);
    expect(seenTenantId).toBe("ten_operator");
    expect(state.signUpCalled).toBe(false);

    // No further retries once a run has happened, even after the retry
    // interval elapses again.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(plantCalls).toBe(1);
  });

  test("retries until the operator bench is provisioned, then plants exactly once", async () => {
    const state: FakeState = {
      signInOk: true,
      signInCount: 0,
      signUpCalled: false,
      unauthorizeOnce: false,
      principals: [],
    };
    let plantCalls = 0;
    const handle = scheduleEnvProviderCredentialPlant({
      baseUrl: BASE_URL,
      envProviderKeys: { anthropic: "sk-ant-test" },
      envProviderBaseUrls: {},
      admin: ADMIN,
      retryIntervalMs: 10,
      maxRetryIntervalMs: 10,
      fetch: fakeFetch(state),
      plant: async () => {
        plantCalls += 1;
        return [{ provider: "anthropic" as const, status: "planted" as const }];
      },
    });
    handles.push(handle);

    // Give it a couple of retry ticks with no bench yet.
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(plantCalls).toBe(0);

    // The bench now exists — as it would once `workbench setup` runs.
    state.principals = [
      {
        tenantId: "ten_operator",
        tenantSlug: "workbench",
        principalId: "prn_admin",
      },
    ];

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(plantCalls).toBe(1);
    expect(state.signUpCalled).toBe(false);
  });

  test("a sign-in failure is retried quietly and never falls through to sign-up", async () => {
    const state: FakeState = {
      signInOk: false,
      signInCount: 0,
      signUpCalled: false,
      unauthorizeOnce: false,
      principals: [],
    };
    let plantCalls = 0;
    const handle = scheduleEnvProviderCredentialPlant({
      baseUrl: BASE_URL,
      envProviderKeys: { anthropic: "sk-ant-test" },
      envProviderBaseUrls: {},
      admin: ADMIN,
      retryIntervalMs: 10,
      maxRetryIntervalMs: 10,
      fetch: fakeFetch(state),
      plant: async () => {
        plantCalls += 1;
        return [];
      },
    });
    handles.push(handle);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(plantCalls).toBe(0);
    // The critical assertion: on an open-signup virgin database, a
    // sign-in-failure retry tick must never mint the default admin
    // account by falling through to sign-up.
    expect(state.signUpCalled).toBe(false);
  });

  test("caches the session across ticks: only one sign-in for repeated unresolved-bench retries", async () => {
    const state: FakeState = {
      signInOk: true,
      signInCount: 0,
      signUpCalled: false,
      unauthorizeOnce: false,
      principals: [],
    };
    const handle = scheduleEnvProviderCredentialPlant({
      baseUrl: BASE_URL,
      envProviderKeys: { anthropic: "sk-ant-test" },
      envProviderBaseUrls: {},
      admin: ADMIN,
      retryIntervalMs: 10,
      maxRetryIntervalMs: 10,
      fetch: fakeFetch(state),
      plant: async () => [
        { provider: "anthropic" as const, status: "planted" as const },
      ],
    });
    handles.push(handle);

    await new Promise((resolve) => setTimeout(resolve, 45));
    // Several ticks elapsed with the bench still unresolved — the bench
    // lookup itself never fails here (it just returns no match), so the
    // session should have been authenticated exactly once and reused.
    expect(state.signInCount).toBe(1);
  });

  test("re-authenticates once when the cached session goes stale (401), inline within the same tick", async () => {
    const state: FakeState = {
      signInOk: true,
      signInCount: 0,
      signUpCalled: false,
      unauthorizeOnce: false,
      principals: [
        {
          tenantId: "ten_operator",
          tenantSlug: "workbench",
          principalId: "prn_admin",
        },
      ],
    };
    let plantCalls = 0;
    const handle = scheduleEnvProviderCredentialPlant({
      baseUrl: BASE_URL,
      envProviderKeys: { anthropic: "sk-ant-test" },
      envProviderBaseUrls: {},
      admin: ADMIN,
      retryIntervalMs: 60,
      maxRetryIntervalMs: 60,
      fetch: fakeFetch(state),
      // Stays unresolved ("blocked") every tick so the session survives
      // across ticks instead of the run going terminal after one pass.
      plant: async () => {
        plantCalls += 1;
        return [{ provider: "anthropic" as const, status: "blocked" as const }];
      },
    });
    handles.push(handle);

    // First tick (immediate): fresh sign-in, session cached.
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(plantCalls).toBe(1);
    expect(state.signInCount).toBe(1);

    // Simulate the cached cookie going stale for the next lookup — the
    // module must re-authenticate once, inline, and still complete the
    // tick's plant, rather than waiting out a full retry interval. The
    // wide 60ms retry interval leaves a comfortable margin so exactly
    // one more tick fires in this window.
    state.unauthorizeOnce = true;
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(plantCalls).toBe(2);
    expect(state.signInCount).toBe(2);
    expect(state.signUpCalled).toBe(false);
  });

  test("a blocked outcome keeps retrying instead of stopping as done", async () => {
    const state: FakeState = {
      signInOk: true,
      signInCount: 0,
      signUpCalled: false,
      unauthorizeOnce: false,
      principals: [
        {
          tenantId: "ten_operator",
          tenantSlug: "workbench",
          principalId: "prn_admin",
        },
      ],
    };
    let plantCalls = 0;
    const handle = scheduleEnvProviderCredentialPlant({
      baseUrl: BASE_URL,
      envProviderKeys: { anthropic: "sk-ant-test" },
      envProviderBaseUrls: {},
      admin: ADMIN,
      retryIntervalMs: 10,
      maxRetryIntervalMs: 10,
      fetch: fakeFetch(state),
      plant: async () => {
        plantCalls += 1;
        return [{ provider: "anthropic" as const, status: "blocked" as const }];
      },
    });
    handles.push(handle);

    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(plantCalls).toBeGreaterThan(1);
  });

  test("gives up after giveUpAfterMs, logging once, and stops retrying", async () => {
    const state: FakeState = {
      signInOk: true,
      signInCount: 0,
      signUpCalled: false,
      unauthorizeOnce: false,
      principals: [],
    };
    let plantCalls = 0;
    const handle = scheduleEnvProviderCredentialPlant({
      baseUrl: BASE_URL,
      envProviderKeys: { anthropic: "sk-ant-test" },
      envProviderBaseUrls: {},
      admin: ADMIN,
      retryIntervalMs: 5,
      maxRetryIntervalMs: 5,
      giveUpAfterMs: 20,
      fetch: fakeFetch(state),
      plant: async () => {
        plantCalls += 1;
        return [{ provider: "anthropic" as const, status: "planted" as const }];
      },
    });
    handles.push(handle);

    await new Promise((resolve) => setTimeout(resolve, 60));
    const plantCallsAtGiveUp = plantCalls;
    expect(plantCallsAtGiveUp).toBe(0);

    state.principals = [
      {
        tenantId: "ten_operator",
        tenantSlug: "workbench",
        principalId: "prn_admin",
      },
    ];
    await new Promise((resolve) => setTimeout(resolve, 40));
    // Given up already — a bench that shows up afterward is never
    // picked up.
    expect(plantCalls).toBe(0);
  });

  test("stop() cancels a pending retry", async () => {
    // No bench yet, so the (already in-flight) first attempt fails and
    // schedules a retry. stop() must cancel that scheduled retry — even
    // though a bench shows up moments later, nothing ever picks it up.
    const state: FakeState = {
      signInOk: true,
      signInCount: 0,
      signUpCalled: false,
      unauthorizeOnce: false,
      principals: [],
    };
    let plantCalls = 0;
    const handle = scheduleEnvProviderCredentialPlant({
      baseUrl: BASE_URL,
      envProviderKeys: { anthropic: "sk-ant-test" },
      envProviderBaseUrls: {},
      admin: ADMIN,
      retryIntervalMs: 10,
      fetch: fakeFetch(state),
      plant: async () => {
        plantCalls += 1;
        return [{ provider: "anthropic" as const, status: "planted" as const }];
      },
    });

    // Let the first (failing) attempt actually run and schedule its
    // retry before stopping — stopping mid-flight on the very first
    // attempt can race the fake fetch's own state read, which is not
    // what this test is about.
    await new Promise((resolve) => setTimeout(resolve, 5));
    handle.stop();
    state.principals = [
      {
        tenantId: "ten_operator",
        tenantSlug: "workbench",
        principalId: "prn_admin",
      },
    ];
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(plantCalls).toBe(0);
  });
});
