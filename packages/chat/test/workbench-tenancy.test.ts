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
import type { ApiCall } from "@corbits/hub-api-client";
import {
  createInMemoryNativeTenantApi,
  createInMemoryWorkbenchTenancyStore,
} from "../src/workbench-tenancy";

test("createWorkbenchTenant mints a tenant and records the parent link", async () => {
  const tenancy = createInMemoryWorkbenchTenancyStore();

  const result = await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_a",
    workbenchId: "ins_general",
    name: "General",
    creatorUserId: "usr_alice",
    cookies: ["session=test"],
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
    cookies: ["session=test"],
  });
  await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_a",
    workbenchId: "ins_a2",
    name: "A Two",
    creatorUserId: "usr_alice",
    cookies: ["session=test"],
  });
  await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_b",
    workbenchId: "ins_b1",
    name: "B One",
    creatorUserId: "usr_bob",
    cookies: ["session=test"],
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
    cookies: ["session=test"],
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
    cookies: ["session=test"],
  });
  await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_a",
    workbenchId: "ins_staying",
    name: "Staying",
    creatorUserId: "usr_alice",
    cookies: ["session=test"],
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
    cookies: ["session=test"],
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
    cookies: ["session=test"],
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
    cookies: ["session=test"],
  });
  await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_a",
    workbenchId: "ins_movable",
    name: "Movable",
    creatorUserId: "usr_alice",
    cookies: ["session=test"],
  });

  const outcome = await tenancy.moveWorkbenchTenancy({
    workbenchId: "ins_movable",
    newParentTenantId: destination.tenantId,
    callerRefId: "usr_alice",
  });

  expect(outcome.kind).toBe("moved");
});

test("compensateWorkbenchTenant removes the tenancy link and leaves the native tenant", async () => {
  const tenancy = createInMemoryWorkbenchTenancyStore();
  const minted = await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_a",
    workbenchId: "ins_orphaned",
    name: "Orphaned",
    creatorUserId: "usr_alice",
    cookies: ["session=test"],
  });
  await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_b",
    workbenchId: "ins_movable",
    name: "Movable",
    creatorUserId: "usr_bob",
    cookies: ["session=test"],
  });

  await tenancy.compensateWorkbenchTenant(minted.tenantId);

  expect(await tenancy.getWorkbenchTenancy("ins_orphaned")).toBeUndefined();
  expect(await tenancy.listWorkbenchTenantIds([minted.tenantId])).toEqual(
    new Set(),
  );
  // Native tenant rows stay — compensation is not a DELETE of Interchange
  // tenants — so the compensated tenant is still a real move destination
  // for a caller who holds manage there (the mint's own creator).
  const outcome = await tenancy.moveWorkbenchTenancy({
    workbenchId: "ins_movable",
    newParentTenantId: minted.tenantId,
    callerRefId: "usr_alice",
  });
  expect(outcome.kind).toBe("moved");
});

test("moveWorkbenchTenancy rejects moving a workbench into its own tenant", async () => {
  const tenancy = createInMemoryWorkbenchTenancyStore();
  const minted = await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_a",
    workbenchId: "ins_general",
    name: "General",
    creatorUserId: "usr_alice",
    cookies: ["session=test"],
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
    cookies: ["session=test"],
  });
  const childWorkbench = await tenancy.createWorkbenchTenant({
    // The child workbench's tenant is parented under the parent
    // workbench's tenant — a real, two-node chain — before the move
    // under test ever runs.
    parentTenantId: parentWorkbench.tenantId,
    workbenchId: "ins_child",
    name: "Child",
    creatorUserId: "usr_alice",
    cookies: ["session=test"],
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
    cookies: ["session=test"],
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
    refId: "prn_bob",
  });

  expect(await tenancy.getTenantPrincipal("tnt_bench_a", "prn_bob")).toEqual({
    id: "prn_bob",
    kind: "user",
    status: "active",
    refId: "prn_bob",
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

test("addWorkbenchMember mints a member-role principal in the workbench's own tenant", async () => {
  const tenancy = createInMemoryWorkbenchTenancyStore();
  const minted = await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_a",
    workbenchId: "ins_general",
    name: "General",
    creatorUserId: "usr_alice",
    cookies: ["session=test"],
  });

  const result = await tenancy.addWorkbenchMember({
    workbenchId: "ins_general",
    refId: "usr_bob",
  });

  expect(result).toEqual({
    tenantId: minted.tenantId,
    principalId: expect.stringMatching(/^prn_/) as unknown as string,
  });
  const member = await tenancy.getTenantPrincipalByRefId(
    minted.tenantId,
    "usr_bob",
  );
  expect(member?.status).toBe("active");
  expect(member?.kind).toBe("user");
});

test("addWorkbenchMember is idempotent for a refId already holding a principal in that tenant", async () => {
  const tenancy = createInMemoryWorkbenchTenancyStore();
  await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_a",
    workbenchId: "ins_general",
    name: "General",
    creatorUserId: "usr_alice",
    cookies: ["session=test"],
  });

  const first = await tenancy.addWorkbenchMember({
    workbenchId: "ins_general",
    refId: "usr_bob",
  });
  const second = await tenancy.addWorkbenchMember({
    workbenchId: "ins_general",
    refId: "usr_bob",
  });

  expect(second).toEqual(first);
});

test("addWorkbenchMember returns undefined for a legacy workbench with no tenancy", async () => {
  const tenancy = createInMemoryWorkbenchTenancyStore();
  expect(
    await tenancy.addWorkbenchMember({
      workbenchId: "ins_legacy",
      refId: "usr_bob",
    }),
  ).toBeUndefined();
});

test("createWorkbenchTenant mints via POST /api/tenants and POST grants, not SQL", async () => {
  const calls: {
    method: string;
    path: string;
    body: unknown;
    cookies: string[] | undefined;
  }[] = [];
  const inner = createInMemoryNativeTenantApi();
  const api: ApiCall = async (method, path, body, cookies) => {
    calls.push({ method, path, body, cookies });
    return inner(method, path, body, cookies);
  };
  const tenancy = createInMemoryWorkbenchTenancyStore({ api });

  const result = await tenancy.createWorkbenchTenant({
    parentTenantId: "tnt_bench_a",
    workbenchId: "ins_general",
    name: "General",
    creatorUserId: "usr_alice",
    cookies: ["session=alice"],
  });

  const tenantPosts = calls.filter(
    (call) => call.method === "POST" && call.path === "/api/tenants",
  );
  expect(tenantPosts).toHaveLength(1);
  expect(tenantPosts[0]?.body).toEqual({
    name: "General",
    slug: expect.stringContaining("general"),
    parentId: "tnt_bench_a",
  });
  expect(tenantPosts[0]?.cookies).toEqual(["session=alice"]);

  const grantPosts = calls.filter(
    (call) =>
      call.method === "POST" &&
      call.path === `/api/tenants/${result.tenantId}/grants`,
  );
  expect(grantPosts).toHaveLength(2);
  expect(grantPosts.map((call) => call.body)).toEqual([
    {
      roleId: expect.stringMatching(/^rol_/),
      resource: "room:*",
      action: "read",
      effect: "allow",
      origin: "creator",
    },
    {
      roleId: expect.stringMatching(/^rol_/),
      resource: "room:*",
      action: "write",
      effect: "allow",
      origin: "creator",
    },
  ]);
  expect(
    calls.every(
      (call) =>
        call.method !== "POST" ||
        call.path === "/api/tenants" ||
        /\/api\/tenants\/[^/]+\/grants$/.test(call.path),
    ),
  ).toBe(true);
});

test("createWorkbenchTenant fails closed when POST /api/tenants is rejected", async () => {
  const api: ApiCall = async () => ({
    status: 403,
    data: { error: { code: "forbidden", message: "nope" } },
    cookies: [],
  });
  const tenancy = createInMemoryWorkbenchTenancyStore({ api });

  await expect(
    tenancy.createWorkbenchTenant({
      parentTenantId: "tnt_bench_a",
      workbenchId: "ins_general",
      name: "General",
      creatorUserId: "usr_alice",
      cookies: ["session=alice"],
    }),
  ).rejects.toThrow("POST /api/tenants failed with status 403");

  expect(await tenancy.getWorkbenchTenancy("ins_general")).toBeUndefined();
});
