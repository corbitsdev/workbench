import { describe, expect, test } from "bun:test";

import {
  canCreateTenancy,
  domainAllowed,
  domainOf,
  evaluateSignupGate,
  resolveAccessPolicy,
} from "./policy";
import { DEFAULT_ACCESS_POLICY, type AccessPolicy } from "./types";

describe("domainOf", () => {
  test("lowercases and takes everything after the last @", () => {
    expect(domainOf("Alice@Acme.Example")).toBe("acme.example");
  });

  test("rejects a value with no @", () => {
    expect(domainOf("not-an-email")).toBeUndefined();
  });

  test("rejects an @ with nothing after it", () => {
    expect(domainOf("alice@")).toBeUndefined();
  });

  test("rejects an @ with nothing before it", () => {
    expect(domainOf("@acme.example")).toBeUndefined();
  });
});

describe("domainAllowed", () => {
  test("an empty allowlist permits any domain", () => {
    expect(domainAllowed("acme.example", [])).toBe(true);
  });

  test("matches case-insensitively against the allowlist", () => {
    expect(domainAllowed("acme.example", ["ACME.example"])).toBe(true);
  });

  test("rejects a domain not on a non-empty allowlist", () => {
    expect(domainAllowed("evil.example", ["acme.example"])).toBe(false);
  });
});

describe("resolveAccessPolicy", () => {
  test("an absent row resolves to closed defaults", () => {
    expect(resolveAccessPolicy(undefined)).toEqual(DEFAULT_ACCESS_POLICY);
  });

  test("a row's allowed_domains JSON column round-trips", () => {
    const resolved = resolveAccessPolicy({
      tenantId: "tnt_1",
      selfSignup: "allowed-domains",
      allowedDomains: JSON.stringify(["acme.example", "widgets.example"]),
      tenancyCreation: "owners-admins",
    });
    expect(resolved).toEqual({
      selfSignup: "allowed-domains",
      allowedDomains: ["acme.example", "widgets.example"],
      tenancyCreation: "owners-admins",
    });
  });

  test("a corrupt allowed_domains column fails closed to an empty list", () => {
    const resolved = resolveAccessPolicy({
      tenantId: "tnt_1",
      selfSignup: "allowed-domains",
      allowedDomains: "{not json",
      tenancyCreation: "owners",
    });
    expect(resolved.allowedDomains).toEqual([]);
  });
});

describe("evaluateSignupGate", () => {
  const email = "person@acme.example";

  test("rejects an unparseable email regardless of policy", () => {
    const result = evaluateSignupGate({
      policy: { ...DEFAULT_ACCESS_POLICY, selfSignup: "open" },
      envSignupMode: "open",
      envAllowedDomains: [],
      email: "not-an-email",
    });
    expect(result).toEqual({ allowed: false, reason: "invalid_email" });
  });

  test("no policy row, env closed (the platform default) -> closed", () => {
    const result = evaluateSignupGate({
      policy: undefined,
      envSignupMode: "closed",
      envAllowedDomains: [],
      email,
    });
    expect(result).toEqual({ allowed: false, reason: "signup_closed" });
  });

  test("no policy row, env open with no domain restriction -> allowed (bootstrap)", () => {
    const result = evaluateSignupGate({
      policy: undefined,
      envSignupMode: "open",
      envAllowedDomains: [],
      email,
    });
    expect(result).toEqual({ allowed: true, reason: "env_open" });
  });

  test("no policy row, env open with a non-matching allowlist -> rejected", () => {
    const result = evaluateSignupGate({
      policy: undefined,
      envSignupMode: "open",
      envAllowedDomains: ["other.example"],
      email,
    });
    expect(result).toEqual({ allowed: false, reason: "domain_not_allowed" });
  });

  test("policy row wins outright: selfSignup off ignores env open", () => {
    const policy: AccessPolicy = {
      selfSignup: "off",
      allowedDomains: [],
      tenancyCreation: "owners",
    };
    const result = evaluateSignupGate({
      policy,
      envSignupMode: "open",
      envAllowedDomains: [],
      email,
    });
    expect(result).toEqual({ allowed: false, reason: "signup_closed" });
  });

  test("policy row wins outright: selfSignup open ignores env closed", () => {
    const policy: AccessPolicy = {
      selfSignup: "open",
      allowedDomains: [],
      tenancyCreation: "owners",
    };
    const result = evaluateSignupGate({
      policy,
      envSignupMode: "closed",
      envAllowedDomains: [],
      email,
    });
    expect(result).toEqual({ allowed: true, reason: "policy_open" });
  });

  test("policy row allowed-domains: a matching domain is allowed", () => {
    const policy: AccessPolicy = {
      selfSignup: "allowed-domains",
      allowedDomains: ["acme.example"],
      tenancyCreation: "owners",
    };
    const result = evaluateSignupGate({
      policy,
      envSignupMode: "closed",
      envAllowedDomains: [],
      email,
    });
    expect(result).toEqual({ allowed: true, reason: "policy_domain_match" });
  });

  test("policy row allowed-domains: a non-matching domain is rejected", () => {
    const policy: AccessPolicy = {
      selfSignup: "allowed-domains",
      allowedDomains: ["widgets.example"],
      tenancyCreation: "owners",
    };
    const result = evaluateSignupGate({
      policy,
      envSignupMode: "open",
      envAllowedDomains: [],
      email,
    });
    expect(result).toEqual({ allowed: false, reason: "domain_not_allowed" });
  });
});

describe("canCreateTenancy", () => {
  test("owners mode: only an owner role passes", () => {
    const policy: AccessPolicy = {
      ...DEFAULT_ACCESS_POLICY,
      tenancyCreation: "owners",
    };
    expect(canCreateTenancy(policy, ["owner"])).toBe(true);
    expect(canCreateTenancy(policy, ["admin"])).toBe(false);
    expect(canCreateTenancy(policy, ["member"])).toBe(false);
    expect(canCreateTenancy(policy, [])).toBe(false);
  });

  test("owners-admins mode: owner or admin passes, member does not", () => {
    const policy: AccessPolicy = {
      ...DEFAULT_ACCESS_POLICY,
      tenancyCreation: "owners-admins",
    };
    expect(canCreateTenancy(policy, ["owner"])).toBe(true);
    expect(canCreateTenancy(policy, ["admin"])).toBe(true);
    expect(canCreateTenancy(policy, ["member"])).toBe(false);
  });

  test("none mode: nobody passes, not even an owner", () => {
    const policy: AccessPolicy = {
      ...DEFAULT_ACCESS_POLICY,
      tenancyCreation: "none",
    };
    expect(canCreateTenancy(policy, ["owner"])).toBe(false);
    expect(canCreateTenancy(policy, ["admin"])).toBe(false);
  });

  test("role names are matched case-insensitively", () => {
    const policy: AccessPolicy = {
      ...DEFAULT_ACCESS_POLICY,
      tenancyCreation: "owners",
    };
    expect(canCreateTenancy(policy, ["Owner"])).toBe(true);
  });
});
