// Contract tests for the in-memory `FederationTrustStore`: bilateral
// trust requires both directions, revocation removes both, and
// `resolveSharedViaParent` distinguishes true siblings from unrelated
// or parent-less tenants. Exercised the same way `channel-tenancy.test.ts`
// exercises the in-memory `ChannelTenancyStore` — pure store contract,
// no HTTP.
import { expect, test } from "bun:test";
import { createInMemoryFederationTrustStore } from "../src/federation-trust";

test("hasBilateralTrust is false until both directions are established", async () => {
  const trust = createInMemoryFederationTrustStore();
  trust.registerTenant("tnt_a", "Acme");
  trust.registerTenant("tnt_b", "Beta");

  expect(await trust.hasBilateralTrust("tnt_a", "tnt_b")).toBe(false);

  await trust.establishBilateralTrust("tnt_a", "tnt_b");

  expect(await trust.hasBilateralTrust("tnt_a", "tnt_b")).toBe(true);
  expect(await trust.hasBilateralTrust("tnt_b", "tnt_a")).toBe(true);
});

test("a single one-directional row is not enough", async () => {
  const trust = createInMemoryFederationTrustStore();
  trust.registerTenant("tnt_a", "Acme");
  trust.registerTenant("tnt_b", "Beta");

  trust.seedDirectionalTrust("tnt_a", "tnt_b", "outbound");

  expect(await trust.hasBilateralTrust("tnt_a", "tnt_b")).toBe(false);
});

test("establishBilateralTrust is idempotent", async () => {
  const trust = createInMemoryFederationTrustStore();
  trust.registerTenant("tnt_a", "Acme");
  trust.registerTenant("tnt_b", "Beta");

  await trust.establishBilateralTrust("tnt_a", "tnt_b");
  await trust.establishBilateralTrust("tnt_a", "tnt_b");

  expect(await trust.hasBilateralTrust("tnt_a", "tnt_b")).toBe(true);
});

test("revokeBilateralTrust removes both directions", async () => {
  const trust = createInMemoryFederationTrustStore();
  trust.registerTenant("tnt_a", "Acme");
  trust.registerTenant("tnt_b", "Beta");
  await trust.establishBilateralTrust("tnt_a", "tnt_b");

  await trust.revokeBilateralTrust("tnt_a", "tnt_b");

  expect(await trust.hasBilateralTrust("tnt_a", "tnt_b")).toBe(false);
  expect(await trust.hasBilateralTrust("tnt_b", "tnt_a")).toBe(false);
});

test("resolveSharedViaParent finds a common parent for true siblings", async () => {
  const trust = createInMemoryFederationTrustStore();
  trust.registerTenant("tnt_parent", "Parent Co");
  trust.registerTenant("tnt_a", "Acme", "tnt_parent");
  trust.registerTenant("tnt_b", "Beta", "tnt_parent");

  const result = await trust.resolveSharedViaParent("tnt_a", "tnt_b");

  expect(result).toEqual({
    parentTenantId: "tnt_parent",
    parentName: "Parent Co",
  });
});

test("resolveSharedViaParent is undefined for unrelated tenants", async () => {
  const trust = createInMemoryFederationTrustStore();
  trust.registerTenant("tnt_parent_a", "Parent A");
  trust.registerTenant("tnt_parent_b", "Parent B");
  trust.registerTenant("tnt_a", "Acme", "tnt_parent_a");
  trust.registerTenant("tnt_b", "Beta", "tnt_parent_b");

  expect(await trust.resolveSharedViaParent("tnt_a", "tnt_b")).toBeUndefined();
});

test("resolveSharedViaParent is undefined when either tenant has no parent", async () => {
  const trust = createInMemoryFederationTrustStore();
  trust.registerTenant("tnt_a", "Acme");
  trust.registerTenant("tnt_b", "Beta");

  expect(await trust.resolveSharedViaParent("tnt_a", "tnt_b")).toBeUndefined();
});

test("getTenantName looks up a registered tenant's name", async () => {
  const trust = createInMemoryFederationTrustStore();
  trust.registerTenant("tnt_a", "Acme");

  expect(await trust.getTenantName("tnt_a")).toBe("Acme");
  expect(await trust.getTenantName("tnt_unknown")).toBeUndefined();
});
