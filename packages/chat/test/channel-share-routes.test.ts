// HTTP-level tests for shared-channel projection (CL-5882): a channel
// owned by one tenant projected into another, gated by bilateral
// federation trust and per-tenant explicit membership. Built the same
// way `channel-subscribers-wiring.test.ts` and `routes.test.ts` build a
// real `createChatRoutes` app over in-memory deps — `mountAsTenant`
// below is `test-support.ts`'s `mountAs` generalized to more than one
// fixed tenant, since this feature is inherently multi-tenant.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { TenantEnv } from "@intx/hub-api";

import { createChatRoutes } from "../src/routes";
import { createInMemoryChannelShareStore } from "../src/channel-share";
import { createInMemoryFederationTrustStore } from "../src/federation-trust";
import { createChannelSubscriberRegistry } from "../src/channel-events";
import {
  buildDeps,
  createChannel,
  fakePlatform,
  principal,
  sendText,
  TENANT,
} from "./test-support";

const TENANT_B = {
  id: "tnt_2",
  name: "Beta Co",
  slug: "beta",
  domain: "beta.example",
  parentId: null,
  config: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const TENANT_C = {
  id: "tnt_3",
  name: "Charlie Co",
  slug: "charlie",
  domain: "charlie.example",
  parentId: null,
  config: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function mountAsTenant(
  routes: Hono<TenantEnv>,
  tenant: typeof TENANT,
  principalId: string,
): Hono<TenantEnv> {
  const asPrincipal: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", tenant);
    c.set("principal", principal(principalId));
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asPrincipal);
  app.route("/", routes);
  return app;
}

describe("shared channel projection", () => {
  test("creating a share without bilateral trust is a 403 and inserts no row", async () => {
    const trust = createInMemoryFederationTrustStore();
    trust.registerTenant(TENANT.id, TENANT.name);
    trust.registerTenant(TENANT_B.id, TENANT_B.name);
    const shares = createInMemoryChannelShareStore({ trust });
    const deps = buildDeps({ shares, trust });
    const routes = createChatRoutes(deps);
    const owner = mountAsTenant(routes, TENANT, "prn_alice");

    const { body: channel } = await createChannel(owner, { kind: "channel" });

    const response = await owner.request(`/channels/${channel.id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectedTenantId: TENANT_B.id }),
    });

    expect(response.status).toBe(403);
    expect(await shares.getShare(channel.id, TENANT_B.id)).toBeUndefined();
  });

  test("bilateral trust then create is 201; one-directional trust still 403s", async () => {
    const trust = createInMemoryFederationTrustStore();
    trust.registerTenant(TENANT.id, TENANT.name);
    trust.registerTenant(TENANT_B.id, TENANT_B.name);
    trust.registerTenant(TENANT_C.id, TENANT_C.name);
    const shares = createInMemoryChannelShareStore({ trust });
    const deps = buildDeps({ shares, trust });
    const routes = createChatRoutes(deps);
    const owner = mountAsTenant(routes, TENANT, "prn_alice");

    const { body: channel } = await createChannel(owner, { kind: "channel" });

    await trust.establishBilateralTrust(TENANT.id, TENANT_B.id);
    trust.seedDirectionalTrust(TENANT.id, TENANT_C.id, "outbound");

    const okResponse = await owner.request(`/channels/${channel.id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectedTenantId: TENANT_B.id }),
    });
    expect(okResponse.status).toBe(201);

    const oneWayResponse = await owner.request(
      `/channels/${channel.id}/shares`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectedTenantId: TENANT_C.id }),
      },
    );
    expect(oneWayResponse.status).toBe(403);
  });

  test("the projected tenant's channel list is empty until a member row exists, then shows a sharedLabel", async () => {
    const trust = createInMemoryFederationTrustStore();
    trust.registerTenant(TENANT.id, TENANT.name);
    trust.registerTenant(TENANT_B.id, TENANT_B.name);
    const shares = createInMemoryChannelShareStore({ trust });
    const deps = buildDeps({ shares, trust });
    const routes = createChatRoutes(deps);
    const owner = mountAsTenant(routes, TENANT, "prn_alice");
    const memberSide = mountAsTenant(routes, TENANT_B, "prn_bob");

    const { body: channel } = await createChannel(owner, { kind: "channel" });
    await trust.establishBilateralTrust(TENANT.id, TENANT_B.id);
    await owner.request(`/channels/${channel.id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectedTenantId: TENANT_B.id }),
    });

    const beforeMember = await (
      await memberSide.request("/channels?kind=channel")
    ).json();
    expect(
      (beforeMember as { items: unknown[] }).items.some(
        (item) => (item as { id: string }).id === channel.id,
      ),
    ).toBe(false);

    const addMemberResponse = await memberSide.request(
      `/channels/${channel.id}/share-members`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ principalId: "prn_bob" }),
      },
    );
    expect(addMemberResponse.status).toBe(200);

    const afterMember = (await (
      await memberSide.request("/channels?kind=channel")
    ).json()) as { items: { id: string; sharedLabel?: string }[] };
    const row = afterMember.items.find((item) => item.id === channel.id);
    expect(row).toBeDefined();
    expect(row?.sharedLabel).toContain("shared");
  });

  test("a third tenant with no share never sees the channel and 404s on direct message access", async () => {
    const trust = createInMemoryFederationTrustStore();
    trust.registerTenant(TENANT.id, TENANT.name);
    trust.registerTenant(TENANT_B.id, TENANT_B.name);
    trust.registerTenant(TENANT_C.id, TENANT_C.name);
    const shares = createInMemoryChannelShareStore({ trust });
    const deps = buildDeps({ shares, trust });
    const routes = createChatRoutes(deps);
    const owner = mountAsTenant(routes, TENANT, "prn_alice");
    const outsider = mountAsTenant(routes, TENANT_C, "prn_carol");

    const { body: channel } = await createChannel(owner, { kind: "channel" });
    await trust.establishBilateralTrust(TENANT.id, TENANT_B.id);
    await owner.request(`/channels/${channel.id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectedTenantId: TENANT_B.id }),
    });

    const list = (await (
      await outsider.request("/channels?kind=channel")
    ).json()) as { items: { id: string }[] };
    expect(list.items.some((item) => item.id === channel.id)).toBe(false);

    const direct = await outsider.request(`/channels/${channel.id}/messages`);
    expect(direct.status).toBe(404);
  });

  test("SSE fan-out reaches both the owning tenant and the projected member tenant", async () => {
    const trust = createInMemoryFederationTrustStore();
    trust.registerTenant(TENANT.id, TENANT.name);
    trust.registerTenant(TENANT_B.id, TENANT_B.name);
    const shares = createInMemoryChannelShareStore({ trust });
    const channelSubscribers = createChannelSubscriberRegistry();
    const deps = buildDeps({ shares, trust, channelSubscribers });
    const routes = createChatRoutes(deps);
    const owner = mountAsTenant(routes, TENANT, "prn_alice");
    const memberSide = mountAsTenant(routes, TENANT_B, "prn_bob");

    const { body: channel } = await createChannel(owner, { kind: "channel" });
    await trust.establishBilateralTrust(TENANT.id, TENANT_B.id);
    await owner.request(`/channels/${channel.id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectedTenantId: TENANT_B.id }),
    });
    await memberSide.request(`/channels/${channel.id}/share-members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "prn_bob" }),
    });

    const received: unknown[] = [];
    channelSubscribers.subscribe(channel.id, (event) => received.push(event));

    // Both an owning-tenant caller and a projected-member-tenant caller
    // can reach the same channel's typing route (fan-out is keyed by
    // channelId only — see channel-events.ts) once resolveChannelAccess
    // lets the member-tenant request past the gate at all.
    const ownerTyping = await owner.request(`/channels/${channel.id}/typing`, {
      method: "POST",
    });
    expect(ownerTyping.status).toBe(202);
    const memberTyping = await memberSide.request(
      `/channels/${channel.id}/typing`,
      { method: "POST" },
    );
    expect(memberTyping.status).toBe(202);

    expect(received).toHaveLength(2);
  });

  test("posting from the projected tenant lands in the owning tenant's mailbox with the correct sender", async () => {
    const trust = createInMemoryFederationTrustStore();
    trust.registerTenant(TENANT.id, TENANT.name);
    trust.registerTenant(TENANT_B.id, TENANT_B.name);
    const shares = createInMemoryChannelShareStore({ trust });
    const platform = fakePlatform();
    const deps = buildDeps({ shares, trust, platform });
    const routes = createChatRoutes(deps);
    const owner = mountAsTenant(routes, TENANT, "prn_alice");
    const memberSide = mountAsTenant(routes, TENANT_B, "prn_bob");

    const { body: channel } = await createChannel(owner, { kind: "channel" });
    await trust.establishBilateralTrust(TENANT.id, TENANT_B.id);
    await owner.request(`/channels/${channel.id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectedTenantId: TENANT_B.id }),
    });
    await memberSide.request(`/channels/${channel.id}/share-members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "prn_bob" }),
    });

    const sendResponse = await sendText(memberSide, channel.id, "hi from beta");
    expect(sendResponse.status).toBe(201);
    const sent = platform.sentMail.find((m) => m.channelId === channel.id);
    expect(sent?.principalId).toBe("prn_bob");

    const ownerMessages = (await (
      await owner.request(`/channels/${channel.id}/messages`)
    ).json()) as { items: { sender: { address: string } }[] };
    expect(
      ownerMessages.items.some((item) =>
        item.sender.address.startsWith("prn_bob@"),
      ),
    ).toBe(true);
  });

  test("per-tenant membership isolation over HTTP: removing tenant B's member does not affect tenant C's", async () => {
    const trust = createInMemoryFederationTrustStore();
    trust.registerTenant(TENANT.id, TENANT.name);
    trust.registerTenant(TENANT_B.id, TENANT_B.name);
    trust.registerTenant(TENANT_C.id, TENANT_C.name);
    const shares = createInMemoryChannelShareStore({ trust });
    const deps = buildDeps({ shares, trust });
    const routes = createChatRoutes(deps);
    const owner = mountAsTenant(routes, TENANT, "prn_alice");
    const bSide = mountAsTenant(routes, TENANT_B, "prn_bob");
    const cSide = mountAsTenant(routes, TENANT_C, "prn_carol");

    const { body: channel } = await createChannel(owner, { kind: "channel" });
    await trust.establishBilateralTrust(TENANT.id, TENANT_B.id);
    await trust.establishBilateralTrust(TENANT.id, TENANT_C.id);
    await owner.request(`/channels/${channel.id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectedTenantId: TENANT_B.id }),
    });
    await owner.request(`/channels/${channel.id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectedTenantId: TENANT_C.id }),
    });
    await bSide.request(`/channels/${channel.id}/share-members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "prn_bob" }),
    });
    await cSide.request(`/channels/${channel.id}/share-members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "prn_carol" }),
    });

    await bSide.request(`/channels/${channel.id}/share-members/prn_bob`, {
      method: "DELETE",
    });

    expect(await shares.isShareMember(TENANT_B.id, channel.id, "prn_bob")).toBe(
      false,
    );
    expect(
      await shares.isShareMember(TENANT_C.id, channel.id, "prn_carol"),
    ).toBe(true);
  });
});
