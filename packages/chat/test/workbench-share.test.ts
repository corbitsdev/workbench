// Contract tests for the in-memory `WorkbenchShareStore`: fail-closed
// creation (no share without bilateral trust), fail-closed membership
// (no member row for a share that doesn't exist), and per-tenant
// membership isolation. Exercised the same way `workbench-tenancy.test.ts`
// exercises `WorkbenchTenancyStore` — pure store contract, no HTTP.
import { expect, test } from "bun:test";
import { createInMemoryWorkbenchShareStore } from "../src/workbench-share";
import { createInMemoryFederationTrustStore } from "../src/federation-trust";

function buildStore() {
  const trust = createInMemoryFederationTrustStore();
  const shares = createInMemoryWorkbenchShareStore({ trust });
  return { trust, shares };
}

test("createShare fails closed without bilateral trust — no row is inserted", async () => {
  const { shares } = buildStore();

  const outcome = await shares.createShare({
    owningTenantId: "tnt_a",
    workbenchId: "ins_general",
    projectedTenantId: "tnt_b",
    createdBy: "prn_alice",
  });

  expect(outcome).toEqual({ kind: "trust_missing" });
  expect(await shares.getShare("ins_general", "tnt_b")).toBeUndefined();
});

test("createShare succeeds once bilateral trust exists", async () => {
  const { trust, shares } = buildStore();
  await trust.establishBilateralTrust("tnt_a", "tnt_b");

  const outcome = await shares.createShare({
    owningTenantId: "tnt_a",
    workbenchId: "ins_general",
    projectedTenantId: "tnt_b",
    createdBy: "prn_alice",
  });

  expect(outcome.kind).toBe("created");
  const row = await shares.getShare("ins_general", "tnt_b");
  expect(row).toMatchObject({
    owningTenantId: "tnt_a",
    workbenchId: "ins_general",
    projectedTenantId: "tnt_b",
    createdBy: "prn_alice",
  });
});

test("createShare reports already_shared on a repeat and does not duplicate the row", async () => {
  const { trust, shares } = buildStore();
  await trust.establishBilateralTrust("tnt_a", "tnt_b");
  await shares.createShare({
    owningTenantId: "tnt_a",
    workbenchId: "ins_general",
    projectedTenantId: "tnt_b",
    createdBy: "prn_alice",
  });

  const outcome = await shares.createShare({
    owningTenantId: "tnt_a",
    workbenchId: "ins_general",
    projectedTenantId: "tnt_b",
    createdBy: "prn_bob",
  });

  expect(outcome).toEqual({ kind: "already_shared" });
  expect(
    (await shares.listSharesForWorkbench("tnt_a", "ins_general")).length,
  ).toBe(1);
});

test("revoking trust after a share exists does not retroactively delete the share", async () => {
  const { trust, shares } = buildStore();
  await trust.establishBilateralTrust("tnt_a", "tnt_b");
  await shares.createShare({
    owningTenantId: "tnt_a",
    workbenchId: "ins_general",
    projectedTenantId: "tnt_b",
    createdBy: "prn_alice",
  });

  await trust.revokeBilateralTrust("tnt_a", "tnt_b");

  expect(await shares.getShare("ins_general", "tnt_b")).toBeDefined();
});

test("revokeShare deletes the row and reports whether one existed", async () => {
  const { trust, shares } = buildStore();
  await trust.establishBilateralTrust("tnt_a", "tnt_b");
  await shares.createShare({
    owningTenantId: "tnt_a",
    workbenchId: "ins_general",
    projectedTenantId: "tnt_b",
    createdBy: "prn_alice",
  });

  expect(await shares.revokeShare("tnt_a", "ins_general", "tnt_b")).toBe(true);
  expect(await shares.getShare("ins_general", "tnt_b")).toBeUndefined();
  expect(await shares.revokeShare("tnt_a", "ins_general", "tnt_b")).toBe(false);
});

test("addShareMember fails closed with no_share when no share row exists", async () => {
  const { shares } = buildStore();

  const outcome = await shares.addShareMember({
    projectedTenantId: "tnt_b",
    workbenchId: "ins_general",
    principalId: "prn_carol",
    addedBy: "prn_bob",
  });

  expect(outcome).toBe("no_share");
  expect(await shares.isShareMember("tnt_b", "ins_general", "prn_carol")).toBe(
    false,
  );
});

test("addShareMember succeeds once a share exists", async () => {
  const { trust, shares } = buildStore();
  await trust.establishBilateralTrust("tnt_a", "tnt_b");
  await shares.createShare({
    owningTenantId: "tnt_a",
    workbenchId: "ins_general",
    projectedTenantId: "tnt_b",
    createdBy: "prn_alice",
  });

  const outcome = await shares.addShareMember({
    projectedTenantId: "tnt_b",
    workbenchId: "ins_general",
    principalId: "prn_carol",
    addedBy: "prn_bob",
  });

  expect(outcome).toBe("added");
  expect(await shares.isShareMember("tnt_b", "ins_general", "prn_carol")).toBe(
    true,
  );
  expect(await shares.listShareMembers("tnt_b", "ins_general")).toEqual([
    "prn_carol",
  ]);
});

test("per-tenant membership isolation: two projected tenants sharing the same workbench keep independent members", async () => {
  const { trust, shares } = buildStore();
  await trust.establishBilateralTrust("tnt_a", "tnt_b");
  await trust.establishBilateralTrust("tnt_a", "tnt_c");
  await shares.createShare({
    owningTenantId: "tnt_a",
    workbenchId: "ins_general",
    projectedTenantId: "tnt_b",
    createdBy: "prn_alice",
  });
  await shares.createShare({
    owningTenantId: "tnt_a",
    workbenchId: "ins_general",
    projectedTenantId: "tnt_c",
    createdBy: "prn_alice",
  });
  await shares.addShareMember({
    projectedTenantId: "tnt_b",
    workbenchId: "ins_general",
    principalId: "prn_carol",
    addedBy: "prn_bob",
  });
  await shares.addShareMember({
    projectedTenantId: "tnt_c",
    workbenchId: "ins_general",
    principalId: "prn_dave",
    addedBy: "prn_carol",
  });

  expect(await shares.isShareMember("tnt_b", "ins_general", "prn_carol")).toBe(
    true,
  );
  expect(await shares.isShareMember("tnt_c", "ins_general", "prn_carol")).toBe(
    false,
  );

  // Removing tenant B's member does not affect tenant C's.
  await shares.removeShareMember("tnt_b", "ins_general", "prn_carol");
  expect(await shares.isShareMember("tnt_b", "ins_general", "prn_carol")).toBe(
    false,
  );
  expect(await shares.isShareMember("tnt_c", "ins_general", "prn_dave")).toBe(
    true,
  );
});

test("listSharesProjectedInto returns every share made into that tenant", async () => {
  const { trust, shares } = buildStore();
  await trust.establishBilateralTrust("tnt_a", "tnt_b");
  await trust.establishBilateralTrust("tnt_x", "tnt_b");
  await shares.createShare({
    owningTenantId: "tnt_a",
    workbenchId: "ins_1",
    projectedTenantId: "tnt_b",
    createdBy: "prn_alice",
  });
  await shares.createShare({
    owningTenantId: "tnt_x",
    workbenchId: "ins_2",
    projectedTenantId: "tnt_b",
    createdBy: "prn_xavier",
  });

  const rows = await shares.listSharesProjectedInto("tnt_b");
  expect(rows.map((row) => row.workbenchId).sort()).toEqual(["ins_1", "ins_2"]);
});
