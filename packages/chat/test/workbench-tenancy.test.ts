// Contract tests for the in-memory `WorkbenchTenancyStore`, exercised
// the same way `store.test.ts` exercises the in-memory `ChatStore`:
// creation records the parent link, listing scopes strictly to the
// requested parent, and a move updates the link without touching any
// other workbench's tenancy. `moveWorkbenchTenancy` folds its destination
// authorization into the same call as the write (see
// `workbench-tenancy.ts`), so every failure mode of that check is
// exercised here as an outcome of `moveWorkbenchTenancy` itself, never
// as a separate pre-check call.
import { expect, test } from "bun:test";
import { createInMemoryWorkbenchTenancyStore } from "../src/workbench-tenancy";

test("createWorkbenchTenant mints a tenant and records the parent link", async () => {
  const tenancy = createInMemoryWorkbenchTenancyStore();

  const result = await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_a",
    workbenchId: "ins_general",
    name: "General",
    creatorUserId: "usr_alice",
  });

  expect(result.tenantId).toMatch(/^tnt_/);
  expect(result.ownerPrincipalId).toMatch(/^prn_/);
  expect(result.slug).toContain("general");
  expect(result.domain).toBe(`${result.slug}.localhost`);

  const link = await tenancy.getWorkbenchTenancy("ins_general");
  expect(link).toEqual({
    workbenchId: "ins_general",
    tenantId: result.tenantId,
    parentTenantId: "tnt_bench_a",
    slug: result.slug,
    createdAt: link?.createdAt as Date,
  });
});

test("getWorkbenchTenancy returns undefined for a workbench with no tenancy — the legacy case", async () => {
  const tenancy = createInMemoryWorkbenchTenancyStore();
  expect(
    await tenancy.getWorkbenchTenancy("ins_predates_rollout"),
  ).toBeUndefined();
});

test("listChildWorkbenchTenancies scopes strictly to the requested parent bench", async () => {
  const tenancy = createInMemoryWorkbenchTenancyStore();
  await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_a",
    workbenchId: "ins_a1",
    name: "A One",
    creatorUserId: "usr_alice",
  });
  await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_a",
    workbenchId: "ins_a2",
    name: "A Two",
    creatorUserId: "usr_alice",
  });
  await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_b",
    workbenchId: "ins_b1",
    name: "B One",
    creatorUserId: "usr_bob",
  });

  const benchAWorkbenches =
    await tenancy.listChildWorkbenchTenancies("tnt_bench_a");
  expect(benchAWorkbenches.map((row) => row.workbenchId).sort()).toEqual([
    "ins_a1",
    "ins_a2",
  ]);

  const benchBWorkbenches =
    await tenancy.listChildWorkbenchTenancies("tnt_bench_b");
  expect(benchBWorkbenches.map((row) => row.workbenchId)).toEqual(["ins_b1"]);
});

test("listWorkbenchTenantIds answers which requested ids are workbench tenancies", async () => {
  const tenancy = createInMemoryWorkbenchTenancyStore();
  const { tenantId: workbenchTenantId } = await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_a",
    workbenchId: "ins_general",
    name: "General",
    creatorUserId: "usr_alice",
  });

  const result = await tenancy.listWorkbenchTenantIds([
    "tnt_bench_a",
    workbenchTenantId,
    "tnt_unrelated",
  ]);

  expect(result).toEqual(new Set([workbenchTenantId]));
});

test("listWorkbenchTenantIds returns an empty set for an empty request", async () => {
  const tenancy = createInMemoryWorkbenchTenancyStore();
  expect(await tenancy.listWorkbenchTenantIds([])).toEqual(new Set());
});

test("moveWorkbenchTenancy re-parents one workbench without disturbing others when the caller manages the destination", async () => {
  const tenancy = createInMemoryWorkbenchTenancyStore();
  await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_a",
    workbenchId: "ins_moving",
    name: "Moving",
    creatorUserId: "usr_alice",
  });
  await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_a",
    workbenchId: "ins_staying",
    name: "Staying",
    creatorUserId: "usr_alice",
  });
  tenancy.registerExistingTenant("tnt_bench_c");
  tenancy.grantManageInTenant("usr_alice", "tnt_bench_c");

  const outcome = await tenancy.moveWorkbenchTenancy({
    workbenchId: "ins_moving",
    newParentTenantId: "tnt_bench_c",
    callerRefId: "usr_alice",
  });
  expect(outcome.kind).toBe("moved");
  expect(outcome.kind === "moved" && outcome.row.parentTenantId).toBe(
    "tnt_bench_c",
  );

  expect(await tenancy.listChildWorkbenchTenancies("tnt_bench_a")).toEqual([
    expect.objectContaining({ workbenchId: "ins_staying" }),
  ]);
  expect(await tenancy.listChildWorkbenchTenancies("tnt_bench_c")).toEqual([
    expect.objectContaining({ workbenchId: "ins_moving" }),
  ]);
});

test("moveWorkbenchTenancy reports a nonexistent destination tenant", async () => {
  const tenancy = createInMemoryWorkbenchTenancyStore();
  await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_a",
    workbenchId: "ins_movable",
    name: "Movable",
    creatorUserId: "usr_alice",
  });

  const outcome = await tenancy.moveWorkbenchTenancy({
    workbenchId: "ins_movable",
    newParentTenantId: "tnt_does_not_exist",
    callerRefId: "usr_alice",
  });

  expect(outcome).toEqual({ kind: "destination_not_found" });
});

test("moveWorkbenchTenancy is forbidden for a real destination tenant the caller has no standing in", async () => {
  const tenancy = createInMemoryWorkbenchTenancyStore();
  await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_a",
    workbenchId: "ins_movable",
    name: "Movable",
    creatorUserId: "usr_alice",
  });
  tenancy.registerExistingTenant("tnt_bench_c");

  const outcome = await tenancy.moveWorkbenchTenancy({
    workbenchId: "ins_movable",
    newParentTenantId: "tnt_bench_c",
    callerRefId: "usr_alice",
  });

  expect(outcome).toEqual({ kind: "forbidden" });
});

test("moveWorkbenchTenancy treats the destination tenant a workbench was minted as manageable by its own creator", async () => {
  const tenancy = createInMemoryWorkbenchTenancyStore();
  const destination = await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_a",
    workbenchId: "ins_general",
    name: "General",
    creatorUserId: "usr_alice",
  });
  await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_a",
    workbenchId: "ins_movable",
    name: "Movable",
    creatorUserId: "usr_alice",
  });

  const outcome = await tenancy.moveWorkbenchTenancy({
    workbenchId: "ins_movable",
    newParentTenantId: destination.tenantId,
    callerRefId: "usr_alice",
  });

  expect(outcome.kind).toBe("moved");
});

test("compensateWorkbenchTenant removes the minted tenant and its tenancy link", async () => {
  const tenancy = createInMemoryWorkbenchTenancyStore();
  const minted = await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_a",
    workbenchId: "ins_orphaned",
    name: "Orphaned",
    creatorUserId: "usr_alice",
  });
  await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_b",
    workbenchId: "ins_movable",
    name: "Movable",
    creatorUserId: "usr_bob",
  });

  await tenancy.compensateWorkbenchTenant(minted.tenantId);

  expect(await tenancy.getWorkbenchTenancy("ins_orphaned")).toBeUndefined();
  const outcome = await tenancy.moveWorkbenchTenancy({
    workbenchId: "ins_movable",
    newParentTenantId: minted.tenantId,
    callerRefId: "usr_alice",
  });
  expect(outcome).toEqual({ kind: "destination_not_found" });
});

test("moveWorkbenchTenancy rejects moving a workbench into its own tenant", async () => {
  const tenancy = createInMemoryWorkbenchTenancyStore();
  const minted = await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_a",
    workbenchId: "ins_general",
    name: "General",
    creatorUserId: "usr_alice",
  });
  // The creator holds a manage grant in its own tenant (seeded as
  // owner) — proving the rejection is structural, not authorization,
  // since a caller with every grant in the world is still refused.
  tenancy.grantManageInTenant("usr_alice", minted.tenantId);

  const outcome = await tenancy.moveWorkbenchTenancy({
    workbenchId: "ins_general",
    newParentTenantId: minted.tenantId,
    callerRefId: "usr_alice",
  });

  expect(outcome).toEqual({ kind: "cycle" });
});

test("moveWorkbenchTenancy rejects a multi-node cycle: moving a workbench into its own descendant", async () => {
  const tenancy = createInMemoryWorkbenchTenancyStore();
  const parentWorkbench = await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_a",
    workbenchId: "ins_parent",
    name: "Parent",
    creatorUserId: "usr_alice",
  });
  const childWorkbench = await tenancy.createWorkbenchTenant({
    // The child workbench's tenant is parented under the parent
    // workbench's tenant — a real, two-node chain — before the move
    // under test ever runs.
    parentTenantId: parentWorkbench.tenantId,
    workbenchId: "ins_child",
    name: "Child",
    creatorUserId: "usr_alice",
  });
  tenancy.grantManageInTenant("usr_alice", childWorkbench.tenantId);

  // Moving the parent workbench into the child's tenant would make the
  // parent its own grandchild's child — a cycle two hops deep, not
  // just a direct self-parent.
  const outcome = await tenancy.moveWorkbenchTenancy({
    workbenchId: "ins_parent",
    newParentTenantId: childWorkbench.tenantId,
    callerRefId: "usr_alice",
  });

  expect(outcome).toEqual({ kind: "cycle" });

  // Neither tenancy link moved.
  expect(await tenancy.getWorkbenchTenancy("ins_parent")).toEqual(
    expect.objectContaining({ parentTenantId: "tnt_bench_a" }),
  );
  expect(await tenancy.getWorkbenchTenancy("ins_child")).toEqual(
    expect.objectContaining({ parentTenantId: parentWorkbench.tenantId }),
  );
});

test("moveWorkbenchTenancy allows moving a workbench into an unrelated tenant that happens to share a grandparent", async () => {
  const tenancy = createInMemoryWorkbenchTenancyStore();
  tenancy.registerExistingTenant("tnt_root");
  tenancy.registerExistingTenant("tnt_sibling", "tnt_root");
  tenancy.grantManageInTenant("usr_alice", "tnt_sibling");
  await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_root",
    workbenchId: "ins_movable",
    name: "Movable",
    creatorUserId: "usr_alice",
  });

  // "tnt_sibling" shares an ancestor ("tnt_root") with the workbench's
  // current tenant but is not itself a descendant of it — a cycle
  // check that only compared "is this the current parent" rather than
  // walking the whole chain could wrongly flag this as related.
  const outcome = await tenancy.moveWorkbenchTenancy({
    workbenchId: "ins_movable",
    newParentTenantId: "tnt_sibling",
    callerRefId: "usr_alice",
  });

  expect(outcome.kind).toBe("moved");
});

test("moveWorkbenchTenancy reports no tenancy for a workbench with no tenancy link, before the destination is even considered", async () => {
  const tenancy = createInMemoryWorkbenchTenancyStore();
  const outcome = await tenancy.moveWorkbenchTenancy({
    workbenchId: "ins_predates_rollout",
    newParentTenantId: "tnt_does_not_exist",
    callerRefId: "usr_alice",
  });
  expect(outcome).toEqual({ kind: "no_tenancy" });
});

test("getTenantPrincipal returns a registered principal scoped to its tenant", async () => {
  const tenancy = createInMemoryWorkbenchTenancyStore();
  tenancy.registerPrincipal("tnt_bench_a", {
    id: "prn_bob",
    kind: "user",
    status: "active",
  });

  expect(await tenancy.getTenantPrincipal("tnt_bench_a", "prn_bob")).toEqual({
    id: "prn_bob",
    kind: "user",
    status: "active",
  });
  // Same principal id, wrong tenant — not found.
  expect(
    await tenancy.getTenantPrincipal("tnt_bench_b", "prn_bob"),
  ).toBeUndefined();
  // Unregistered principal id — not found.
  expect(
    await tenancy.getTenantPrincipal("tnt_bench_a", "prn_ghost"),
  ).toBeUndefined();
});
