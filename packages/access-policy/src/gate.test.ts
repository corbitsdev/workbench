import { describe, expect, test } from "bun:test";
import type { ApiCall, ApiResult } from "@workbench/hub-client";

import { checkSignupGate, resolvePendingInviteOnLogin } from "./gate";
import { createInMemoryAccessPolicyStore } from "./store";

describe("checkSignupGate", () => {
  test("no operator tenant configured -> only the env flag can gate", async () => {
    const store = createInMemoryAccessPolicyStore();
    const result = await checkSignupGate({
      store,
      envSignupMode: "closed",
      envAllowedDomains: [],
      email: "person@acme.example",
    });
    expect(result).toEqual({ allowed: false, reason: "signup_closed" });
  });

  test("operator tenant with no policy row yet -> env flag bootstraps", async () => {
    const store = createInMemoryAccessPolicyStore();
    const result = await checkSignupGate({
      store,
      operatorTenantId: "tnt_operator",
      envSignupMode: "open",
      envAllowedDomains: [],
      email: "person@acme.example",
    });
    expect(result).toEqual({ allowed: true, reason: "env_open" });
  });

  test("operator tenant with an explicit closed row overrides an open env flag", async () => {
    const store = createInMemoryAccessPolicyStore();
    await store.upsertPolicy("tnt_operator", { selfSignup: "off" });
    const result = await checkSignupGate({
      store,
      operatorTenantId: "tnt_operator",
      envSignupMode: "open",
      envAllowedDomains: [],
      email: "person@acme.example",
    });
    expect(result).toEqual({ allowed: false, reason: "signup_closed" });
  });

  test("operator tenant with an explicit open row overrides a closed env flag", async () => {
    const store = createInMemoryAccessPolicyStore();
    await store.upsertPolicy("tnt_operator", { selfSignup: "open" });
    const result = await checkSignupGate({
      store,
      operatorTenantId: "tnt_operator",
      envSignupMode: "closed",
      envAllowedDomains: [],
      email: "person@acme.example",
    });
    expect(result).toEqual({ allowed: true, reason: "policy_open" });
  });

  test("a policy row scoped to a different tenant never leaks into this check", async () => {
    const store = createInMemoryAccessPolicyStore();
    await store.upsertPolicy("tnt_other", { selfSignup: "open" });
    const result = await checkSignupGate({
      store,
      operatorTenantId: "tnt_operator",
      envSignupMode: "closed",
      envAllowedDomains: [],
      email: "person@acme.example",
    });
    expect(result).toEqual({ allowed: false, reason: "signup_closed" });
  });
});

function fakeApi(
  handler: (method: string, path: string, body: unknown) => ApiResult,
): ApiCall {
  return async (method, path, body) => handler(method, path, body);
}

describe("resolvePendingInviteOnLogin", () => {
  test("no matching invite -> undefined, no native calls made", async () => {
    const store = createInMemoryAccessPolicyStore();
    let calls = 0;
    const api = fakeApi(() => {
      calls += 1;
      throw new Error("should not be called");
    });
    const result = await resolvePendingInviteOnLogin({
      store,
      api,
      cookies: [],
      email: "nobody@acme.example",
    });
    expect(result).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("an exact-email match invites, activates, and is consumed", async () => {
    const store = createInMemoryAccessPolicyStore();
    const invite = await store.createPendingInvite("tnt_acme", {
      matchType: "email",
      value: "Person@Acme.example",
      roleId: "rol_member",
    });

    const calls: { method: string; path: string; body: unknown }[] = [];
    const api = fakeApi((method, path, body) => {
      calls.push({ method, path, body });
      if (method === "POST" && path.endsWith("/members/invite")) {
        return { status: 201, data: { id: "prn_new" }, cookies: [] };
      }
      if (method === "PATCH" && path.endsWith("/prn_new")) {
        return { status: 200, data: { id: "prn_new" }, cookies: [] };
      }
      throw new Error(`unexpected call ${method} ${path}`);
    });

    const result = await resolvePendingInviteOnLogin({
      store,
      api,
      cookies: ["session=abc"],
      email: "person@acme.example",
    });

    expect(result).toEqual({ tenantId: "tnt_acme", principalId: "prn_new" });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/tenants/tnt_acme/members/invite",
        body: { email: "person@acme.example", roleId: "rol_member" },
      },
      {
        method: "PATCH",
        path: "/api/tenants/tnt_acme/principals/prn_new",
        body: { status: "active" },
      },
    ]);

    const stillMatches = await store.findMatchingPendingInvite(
      "person@acme.example",
    );
    expect(stillMatches).toBeUndefined();
    void invite;
  });

  test("a domain-wildcard match resolves but is never consumed (a standing rule)", async () => {
    const store = createInMemoryAccessPolicyStore();
    await store.createPendingInvite("tnt_acme", {
      matchType: "domain",
      value: "acme.example",
    });

    const api = fakeApi((method, path) => {
      if (method === "POST" && path.endsWith("/members/invite")) {
        return { status: 201, data: { id: "prn_new" }, cookies: [] };
      }
      if (method === "PATCH") {
        return { status: 200, data: { id: "prn_new" }, cookies: [] };
      }
      throw new Error(`unexpected call ${method} ${path}`);
    });

    const first = await resolvePendingInviteOnLogin({
      store,
      api,
      cookies: [],
      email: "anyone@acme.example",
    });
    expect(first).toEqual({ tenantId: "tnt_acme", principalId: "prn_new" });

    const second = await resolvePendingInviteOnLogin({
      store,
      api,
      cookies: [],
      email: "someone-else@acme.example",
    });
    expect(second).toEqual({ tenantId: "tnt_acme", principalId: "prn_new" });
  });

  test("a redemption failure at the native invite route throws, and nothing is consumed", async () => {
    const store = createInMemoryAccessPolicyStore();
    await store.createPendingInvite("tnt_acme", {
      matchType: "email",
      value: "person@acme.example",
    });
    const api = fakeApi(() => ({
      status: 409,
      data: { error: { code: "conflict" } },
      cookies: [],
    }));

    await expect(
      resolvePendingInviteOnLogin({
        store,
        api,
        cookies: [],
        email: "person@acme.example",
      }),
    ).rejects.toThrow(/could not be redeemed/);

    const stillPending = await store.findMatchingPendingInvite(
      "person@acme.example",
    );
    expect(stillPending).toBeDefined();
  });
});
