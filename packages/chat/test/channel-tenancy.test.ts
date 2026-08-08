// Contract tests for the in-memory `ChannelTenancyStore`, exercised
// the same way `store.test.ts` exercises the in-memory `ChatStore`:
// creation records the parent link, listing scopes strictly to the
// requested parent, and a move updates the link without touching any
// other channel's tenancy.
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

test("moveChannelTenancy re-parents one channel without disturbing others", async () => {
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

  const moved = await tenancy.moveChannelTenancy({
    channelId: "ins_moving",
    newParentTenantId: "tnt_bench_c",
  });
  expect(moved.parentTenantId).toBe("tnt_bench_c");

  expect(await tenancy.listChildChannelTenancies("tnt_bench_a")).toEqual([
    expect.objectContaining({ channelId: "ins_staying" }),
  ]);
  expect(await tenancy.listChildChannelTenancies("tnt_bench_c")).toEqual([
    expect.objectContaining({ channelId: "ins_moving" }),
  ]);
});

test("moveChannelTenancy rejects a channel with no tenancy link", async () => {
  const tenancy = createInMemoryChannelTenancyStore();
  await expect(
    tenancy.moveChannelTenancy({
      channelId: "ins_predates_rollout",
      newParentTenantId: "tnt_bench_c",
    }),
  ).rejects.toThrow(/no channel tenancy/i);
});
