import { describe, expect, test } from "bun:test";

import { checkSignupGate } from "./gate";
import { createInMemoryAccessPolicyStore } from "./store";

const verified = { emailVerified: true, allowUnverifiedEmails: false };

describe("checkSignupGate", () => {
  test("no operator tenant configured -> only the env flag can gate", async () => {
    const store = createInMemoryAccessPolicyStore();
    const result = await checkSignupGate({
      store,
      envSignupMode: "closed",
      envAllowedDomains: [],
      email: "person@acme.example",
      ...verified,
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
      ...verified,
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
      ...verified,
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
      ...verified,
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
      ...verified,
    });
    expect(result).toEqual({ allowed: false, reason: "signup_closed" });
  });

  test("exploit: an unverified email cannot self-sign-up even with an open policy", async () => {
    const store = createInMemoryAccessPolicyStore();
    await store.upsertPolicy("tnt_operator", { selfSignup: "open" });
    const result = await checkSignupGate({
      store,
      operatorTenantId: "tnt_operator",
      envSignupMode: "closed",
      envAllowedDomains: [],
      email: "attacker@acme.example",
      emailVerified: false,
      allowUnverifiedEmails: false,
    });
    expect(result).toEqual({ allowed: false, reason: "email_unverified" });
  });

  test("ALLOW_UNVERIFIED_EMAILS opt-out restores the ordinary decision", async () => {
    const store = createInMemoryAccessPolicyStore();
    await store.upsertPolicy("tnt_operator", { selfSignup: "open" });
    const result = await checkSignupGate({
      store,
      operatorTenantId: "tnt_operator",
      envSignupMode: "closed",
      envAllowedDomains: [],
      email: "dev@acme.example",
      emailVerified: false,
      allowUnverifiedEmails: true,
    });
    expect(result).toEqual({ allowed: true, reason: "policy_open" });
  });
});
