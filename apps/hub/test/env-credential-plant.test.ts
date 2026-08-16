// The retry-until-resolved scheduling `scheduleEnvProviderCredentialPlant`
// owns: finding the operator bench (sign in as the admin, resolve its
// slug) and, once found, running the plant exactly once. The actual
// planting is `@workbench/onboarding`'s own, thoroughly tested
// `plantEnvProviderCredentials` — these tests fake it out (the `plant`
// seam) so they only prove this module's own job: resolve, then hand
// off, retrying quietly when the bench does not exist yet.

import { afterEach, describe, expect, test } from "bun:test";
import { scheduleEnvProviderCredentialPlant } from "../src/env-credential-plant.ts";

const BASE_URL = "http://hub.test";
const ADMIN = { email: "alice@example.com", password: "password123", orgSlug: "workbench" };

type FakeState = {
  principals: { tenantId: string; tenantSlug: string; principalId: string }[];
  signInOk: boolean;
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "set-cookie": "session=abc" },
  });
}

function fakeFetch(state: FakeState): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/auth/sign-in/email") {
      return state.signInOk
        ? json({ user: { id: "usr_admin" } })
        : json({ error: "invalid_credentials" }, 401);
    }
    if (url.pathname === "/api/me/principals") {
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
      admin: ADMIN,
      fetch: async (request) => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      },
      plant: (async () => {
        plantCalled = true;
        return [];
      }) as never,
    });
    handles.push(handle);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchCalled).toBe(false);
    expect(plantCalled).toBe(false);
  });

  test("the operator bench already exists: plants once immediately, no retries", async () => {
    const state: FakeState = {
      signInOk: true,
      principals: [
        { tenantId: "ten_operator", tenantSlug: "workbench", principalId: "prn_admin" },
      ],
    };
    let plantCalls = 0;
    let seenTenantId: string | undefined;
    const handle = scheduleEnvProviderCredentialPlant({
      baseUrl: BASE_URL,
      envProviderKeys: { anthropic: "sk-ant-test" },
      admin: ADMIN,
      retryIntervalMs: 10,
      fetch: fakeFetch(state),
      plant: (async (args: { tenantId: string }) => {
        plantCalls += 1;
        seenTenantId = args.tenantId;
        return [{ provider: "anthropic" as const, status: "planted" as const }];
      }) as never,
    });
    handles.push(handle);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(plantCalls).toBe(1);
    expect(seenTenantId).toBe("ten_operator");

    // No further retries once a run has happened, even after the retry
    // interval elapses again.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(plantCalls).toBe(1);
  });

  test("retries until the operator bench is provisioned, then plants exactly once", async () => {
    const state: FakeState = { signInOk: true, principals: [] };
    let plantCalls = 0;
    const handle = scheduleEnvProviderCredentialPlant({
      baseUrl: BASE_URL,
      envProviderKeys: { anthropic: "sk-ant-test" },
      admin: ADMIN,
      retryIntervalMs: 10,
      fetch: fakeFetch(state),
      plant: (async () => {
        plantCalls += 1;
        return [{ provider: "anthropic" as const, status: "planted" as const }];
      }) as never,
    });
    handles.push(handle);

    // Give it a couple of retry ticks with no bench yet.
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(plantCalls).toBe(0);

    // The bench now exists — as it would once `workbench setup` runs.
    state.principals = [
      { tenantId: "ten_operator", tenantSlug: "workbench", principalId: "prn_admin" },
    ];

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(plantCalls).toBe(1);
  });

  test("an auth failure is retried quietly, never thrown out of the scheduler", async () => {
    const state: FakeState = { signInOk: false, principals: [] };
    let plantCalls = 0;
    const handle = scheduleEnvProviderCredentialPlant({
      baseUrl: BASE_URL,
      envProviderKeys: { anthropic: "sk-ant-test" },
      admin: ADMIN,
      retryIntervalMs: 10,
      fetch: fakeFetch(state),
      plant: (async () => {
        plantCalls += 1;
        return [];
      }) as never,
    });
    handles.push(handle);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(plantCalls).toBe(0);
  });

  test("stop() cancels a pending retry", async () => {
    // No bench yet, so the (already in-flight) first attempt fails and
    // schedules a retry. stop() must cancel that scheduled retry — even
    // though a bench shows up moments later, nothing ever picks it up.
    const state: FakeState = { signInOk: true, principals: [] };
    let plantCalls = 0;
    const handle = scheduleEnvProviderCredentialPlant({
      baseUrl: BASE_URL,
      envProviderKeys: { anthropic: "sk-ant-test" },
      admin: ADMIN,
      retryIntervalMs: 10,
      fetch: fakeFetch(state),
      plant: (async () => {
        plantCalls += 1;
        return [{ provider: "anthropic" as const, status: "planted" as const }];
      }) as never,
    });

    // Let the first (failing) attempt actually run and schedule its
    // retry before stopping — stopping mid-flight on the very first
    // attempt can race the fake fetch's own state read, which is not
    // what this test is about.
    await new Promise((resolve) => setTimeout(resolve, 5));
    handle.stop();
    state.principals = [
      { tenantId: "ten_operator", tenantSlug: "workbench", principalId: "prn_admin" },
    ];
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(plantCalls).toBe(0);
  });
});
