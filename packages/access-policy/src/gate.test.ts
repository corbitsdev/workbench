import { describe, expect, test } from "bun:test";

import { checkSignupGate } from "./gate";
import { createInMemoryAccessPolicyStore } from "./store";

const verified = { emailVerified: true, allowUnverifiedEmails: false };

describe("checkSignupGate", () => {
  test("no operator tenant configured -> closed defaults", async () => {
    const store = createInMemoryAccessPolicyStore();
    const result = await checkSignupGate({
      store,
      email: "person@acme.example",
      ...verified,
    });
    expect(result).toEqual({ allowed: false, reason: "signup_closed" });
  });

  test("operator tenant with no policy row yet -> closed defaults", async () => {
    const store = createInMemoryAccessPolicyStore();
    const result = await checkSignupGate({
      store,
      operatorTenantId: "tnt_operator",
      email: "person@acme.example",
      ...verified,
    });
    expect(result).toEqual({ allowed: false, reason: "signup_closed" });
  });

  test("operator tenant with an explicit closed row stays closed", async () => {
    const store = createInMemoryAccessPolicyStore();
    await store.upsertPolicy("tnt_operator", { selfSignup: "off" });
    const result = await checkSignupGate({
      store,
      operatorTenantId: "tnt_operator",
      email: "person@acme.example",
      ...verified,
    });
    expect(result).toEqual({ allowed: false, reason: "signup_closed" });
  });

  test("operator tenant with an explicit open row allows", async () => {
    const store = createInMemoryAccessPolicyStore();
    await store.upsertPolicy("tnt_operator", { selfSignup: "open" });
    const result = await checkSignupGate({
      store,
      operatorTenantId: "tnt_operator",
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
      email: "attacker@acme.example",
      emailVerified: false,
      allowUnverifiedEmails: false,
    });
    expect(result).toEqual({ allowed: false, reason: "email_unverified" });
  });

  test("allowUnverifiedEmails opt-out restores the ordinary decision", async () => {
    const store = createInMemoryAccessPolicyStore();
    await store.upsertPolicy("tnt_operator", { selfSignup: "open" });
    const result = await checkSignupGate({
      store,
      operatorTenantId: "tnt_operator",
      email: "dev@acme.example",
      emailVerified: false,
      allowUnverifiedEmails: true,
    });
    expect(result).toEqual({ allowed: true, reason: "policy_open" });
  });
});
