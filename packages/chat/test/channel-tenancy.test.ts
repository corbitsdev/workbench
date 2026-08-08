// Contract tests for the in-memory `ChannelTenancyStore`, exercised
// the same way `store.test.ts` exercises the in-memory `ChatStore`:
// creation records the parent link, listing scopes strictly to the
// requested parent, and a move updates the link without touching any
// other channel's tenancy. `moveChannelTenancy` folds its destination
// authorization into the same call as the write (see
// `channel-tenancy.ts`), so every failure mode of that check is
// exercised here as an outcome of `moveChannelTenancy` itself, never
// as a separate pre-check call.
import { expect, test } from "bun:test";
import { createInMemoryChannelTenancyStore } from "../src/channel-tenancy";

test("createChannelTenant mints a tenant and records the parent link", async () => {
  const tenancy = createInMemoryChannelTenancyStore();

  const result = await tenancy.createChannelTenant({
    parentTenantId: "tnt_bench_a",
    channelId: "ins_general",
    name: "General",
    creatorUserId: "usr_alice",
  });

  expect(result.tenantId).toMatch(/^tnt_/);
  expect(result.ownerPrincipalId).toMatch(/^prn_/);
  expect(result.slug).toContain("general");
  expect(result.domain).toBe(`${result.slug}.localhost`);

  const link = await tenancy.getChannelTenancy("ins_general");
  expect(link).toEqual({
    channelId: "ins_general",
    tenantId: result.tenantId,
    parentTenantId: "tnt_bench_a",
    slug: result.slug,
    createdAt: link?.createdAt as Date,
  });
});

test("getChannelTenancy returns undefined for a channel with no tenancy — the legacy case", async () => {
  const tenancy = createInMemoryChannelTenancyStore();
  expect(
    await tenancy.getChannelTenancy("ins_predates_rollout"),
  ).toBeUndefined();
});

test("listChildChannelTenancies scopes strictly to the requested parent bench", async () => {
  const tenancy = createInMemoryChannelTenancyStore();
  await tenancy.createChannelTenant({
    parentTenantId: "tnt_bench_a",
    channelId: "ins_a1",
    name: "A One",
    creatorUserId: "usr_alice",
  });
  await tenancy.createChannelTenant({
    parentTenantId: "tnt_bench_a",
    channelId: "ins_a2",
    name: "A Two",
    creatorUserId: "usr_alice",
  });
  await tenancy.createChannelTenant({
    parentTenantId: "tnt_bench_b",
    channelId: "ins_b1",
    name: "B One",
    creatorUserId: "usr_bob",
  });

  const benchAChannels = await tenancy.listChildChannelTenancies("tnt_bench_a");
  expect(benchAChannels.map((row) => row.channelId).sort()).toEqual([
    "ins_a1",
    "ins_a2",
  ]);

  const benchBChannels = await tenancy.listChildChannelTenancies("tnt_bench_b");
  expect(benchBChannels.map((row) => row.channelId)).toEqual(["ins_b1"]);
});

test("moveChannelTenancy re-parents one channel without disturbing others when the caller manages the destination", async () => {
  const tenancy = createInMemoryChannelTenancyStore();
  await tenancy.createChannelTenant({
    parentTenantId: "tnt_bench_a",
    channelId: "ins_moving",
    name: "Moving",
    creatorUserId: "usr_alice",
  });
  await tenancy.createChannelTenant({
    parentTenantId: "tnt_bench_a",
    channelId: "ins_staying",
    name: "Staying",
    creatorUserId: "usr_alice",
  });
  tenancy.registerExistingTenant("tnt_bench_c");
  tenancy.grantManageInTenant("usr_alice", "tnt_bench_c");

  const outcome = await tenancy.moveChannelTenancy({
    channelId: "ins_moving",
    newParentTenantId: "tnt_bench_c",
    callerRefId: "usr_alice",
  });
  expect(outcome.kind).toBe("moved");
  expect(outcome.kind === "moved" && outcome.row.parentTenantId).toBe(
    "tnt_bench_c",
  );

  expect(await tenancy.listChildChannelTenancies("tnt_bench_a")).toEqual([
    expect.objectContaining({ channelId: "ins_staying" }),
  ]);
  expect(await tenancy.listChildChannelTenancies("tnt_bench_c")).toEqual([
    expect.objectContaining({ channelId: "ins_moving" }),
  ]);
});

test("moveChannelTenancy reports a nonexistent destination tenant", async () => {
  const tenancy = createInMemoryChannelTenancyStore();
  await tenancy.createChannelTenant({
    parentTenantId: "tnt_bench_a",
    channelId: "ins_movable",
    name: "Movable",
    creatorUserId: "usr_alice",
  });

  const outcome = await tenancy.moveChannelTenancy({
    channelId: "ins_movable",
    newParentTenantId: "tnt_does_not_exist",
    callerRefId: "usr_alice",
  });

  expect(outcome).toEqual({ kind: "destination_not_found" });
});

test("moveChannelTenancy is forbidden for a real destination tenant the caller has no standing in", async () => {
  const tenancy = createInMemoryChannelTenancyStore();
  await tenancy.createChannelTenant({
    parentTenantId: "tnt_bench_a",
    channelId: "ins_movable",
    name: "Movable",
    creatorUserId: "usr_alice",
  });
  tenancy.registerExistingTenant("tnt_bench_c");

  const outcome = await tenancy.moveChannelTenancy({
    channelId: "ins_movable",
    newParentTenantId: "tnt_bench_c",
    callerRefId: "usr_alice",
  });

  expect(outcome).toEqual({ kind: "forbidden" });
});

test("moveChannelTenancy treats the destination tenant a channel was minted as manageable by its own creator", async () => {
  const tenancy = createInMemoryChannelTenancyStore();
  const destination = await tenancy.createChannelTenant({
    parentTenantId: "tnt_bench_a",
    channelId: "ins_general",
    name: "General",
    creatorUserId: "usr_alice",
  });
  await tenancy.createChannelTenant({
    parentTenantId: "tnt_bench_a",
    channelId: "ins_movable",
    name: "Movable",
    creatorUserId: "usr_alice",
  });

  const outcome = await tenancy.moveChannelTenancy({
    channelId: "ins_movable",
    newParentTenantId: destination.tenantId,
    callerRefId: "usr_alice",
  });

  expect(outcome.kind).toBe("moved");
});

test("compensateChannelTenant removes the minted tenant and its tenancy link", async () => {
  const tenancy = createInMemoryChannelTenancyStore();
  const minted = await tenancy.createChannelTenant({
    parentTenantId: "tnt_bench_a",
    channelId: "ins_orphaned",
    name: "Orphaned",
    creatorUserId: "usr_alice",
  });
  await tenancy.createChannelTenant({
    parentTenantId: "tnt_bench_b",
    channelId: "ins_movable",
    name: "Movable",
    creatorUserId: "usr_bob",
  });

  await tenancy.compensateChannelTenant(minted.tenantId);

  expect(await tenancy.getChannelTenancy("ins_orphaned")).toBeUndefined();
  const outcome = await tenancy.moveChannelTenancy({
    channelId: "ins_movable",
    newParentTenantId: minted.tenantId,
    callerRefId: "usr_alice",
  });
  expect(outcome).toEqual({ kind: "destination_not_found" });
});

test("moveChannelTenancy reports no tenancy for a channel with no tenancy link, before the destination is even considered", async () => {
  const tenancy = createInMemoryChannelTenancyStore();
  const outcome = await tenancy.moveChannelTenancy({
    channelId: "ins_predates_rollout",
    newParentTenantId: "tnt_does_not_exist",
    callerRefId: "usr_alice",
  });
  expect(outcome).toEqual({ kind: "no_tenancy" });
});
