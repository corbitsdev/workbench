// Room access as its own resource in the grant grammar (CL-6346): a
// workbench's messages are gated by `resolveWorkbenchAccess`'s
// membership/visibility check, never by a `workflow-run` grant — the
// room stopped being a run when CL-6327 made it workbench data. Visits
// two bench members through the same `deps` (so both see the same
// workbench), one who minted the workbench (and so holds a principal
// in its own child tenant) and one who is only ever a member of the
// owning bench.
import { describe, expect, test } from "bun:test";

import { createChatRoutes } from "../src/routes";
import { createInMemoryWorkbenchTenancyStore } from "../src/workbench-tenancy";
import {
  buildDeps,
  createWorkbench,
  mountAs,
  sendText,
  TENANT,
} from "./test-support";

describe("room access", () => {
  test("a bench member opens a bench-visible workbench with no explicit invite", async () => {
    const deps = buildDeps();
    const asAlice = mountAs(createChatRoutes(deps), "prn_alice");
    const asBob = mountAs(createChatRoutes(deps), "prn_bob");

    const { body } = await createWorkbench(asAlice, { kind: "workbench" });

    // Bob never joined this workbench's own child tenant — he only
    // ever authenticated within the owning bench. Bench-visible is the
    // default, so he still reads and writes its timeline.
    const read = await asBob.request(`/workbenches/${body.id}/messages`);
    expect(read.status).toBe(200);

    const sent = await sendText(asBob, body.id, "hey from bob");
    expect(sent.status).toBe(201);
  });

  test("a non-member is denied once a workbench is flipped to members-only", async () => {
    const deps = buildDeps();
    const asAlice = mountAs(createChatRoutes(deps), "prn_alice");
    const asBob = mountAs(createChatRoutes(deps), "prn_bob");

    const { body } = await createWorkbench(asAlice, { kind: "workbench" });

    const flip = await asAlice.request(`/workbenches/${body.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/visibility": "members" }),
    });
    expect(flip.status).toBe(200);

    // Alice minted the workbench, so `createWorkbenchTenant` already
    // holds her as its own tenant's owner principal — she keeps access.
    const aliceRead = await asAlice.request(`/workbenches/${body.id}/messages`);
    expect(aliceRead.status).toBe(200);

    // Bob holds no principal in the workbench's own tenant, and it no
    // longer falls back to bench-visible — both read and write 404
    // exactly as an unknown workbench would, never leaking its existence.
    const bobRead = await asBob.request(`/workbenches/${body.id}/messages`);
    expect(bobRead.status).toBe(404);

    const bobSend = await asBob.request(`/workbenches/${body.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ kind: "text", text: "hi" }] }),
    });
    expect(bobSend.status).toBe(404);
  });

  test("posting a message is authorized on the room resource, with zero run-grant involvement", async () => {
    const grantChecks: { resource: string; action: string }[] = [];
    const deps = buildDeps({
      requireGrant: (resource, action) => async (c, next) => {
        const resolved =
          typeof resource === "function"
            ? resource({ param: (name) => c.req.param(name) })
            : resource;
        grantChecks.push({ resource: resolved, action });
        await next();
      },
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const { body } = await createWorkbench(app, { kind: "workbench" });
    grantChecks.length = 0;

    const response = await sendText(app, body.id, "hello room");

    expect(response.status).toBe(201);
    expect(grantChecks).toEqual([
      { resource: `room:${body.id}`, action: "write" },
    ]);
    expect(
      grantChecks.some((check) => check.resource.startsWith("workflow-run")),
    ).toBe(false);
  });

  test("inviting a person mints them a member-role principal in the workbench's own tenant, unblocking a members-only flip", async () => {
    const deps = buildDeps();
    (
      deps.tenancy as ReturnType<typeof createInMemoryWorkbenchTenancyStore>
    ).registerPrincipal(TENANT.id, {
      id: "prn_bob",
      kind: "user",
      status: "active",
      refId: "prn_bob",
    });
    const asAlice = mountAs(createChatRoutes(deps), "prn_alice");
    const asBob = mountAs(createChatRoutes(deps), "prn_bob");

    const { body } = await createWorkbench(asAlice, { kind: "workbench" });

    // Bob is invited through the mention popover's pre-invite path
    // (CL-6332) before the workbench ever flips to members-only —
    // the mint happens on invite, not on first access.
    const invited = await asAlice.request(`/workbenches/${body.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ kind: "text", text: "@bob welcome!" }],
        invite: [{ kind: "person", principalId: "prn_bob", name: "Bob" }],
      }),
    });
    expect(invited.status).toBe(201);

    const flip = await asAlice.request(`/workbenches/${body.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/visibility": "members" }),
    });
    expect(flip.status).toBe(200);

    // Bob was invited before the flip; he still opens and writes it —
    // the members-only check reads his membership in the workbench's
    // own tenant, not whether he was invited before or after the flip.
    const bobRead = await asBob.request(`/workbenches/${body.id}/messages`);
    expect(bobRead.status).toBe(200);

    const bobSend = await sendText(asBob, body.id, "thanks for the invite");
    expect(bobSend.status).toBe(201);

    // `chat/participants` still carries only the mention handle — the
    // access decision above never consulted it.
    const settingsResponse = await asAlice.request(
      `/workbenches/${body.id}/settings`,
    );
    const settingsBody = (await settingsResponse.json()) as {
      participants: { address: string; handle: string }[];
    };
    expect(settingsBody.participants).toEqual([
      { address: "prn_bob", handle: "bob" },
    ]);
  });

  test("a bench member never invited into a members-only workbench is still denied after another person's invite", async () => {
    const deps = buildDeps();
    (
      deps.tenancy as ReturnType<typeof createInMemoryWorkbenchTenancyStore>
    ).registerPrincipal(TENANT.id, {
      id: "prn_bob",
      kind: "user",
      status: "active",
      refId: "prn_bob",
    });
    (
      deps.tenancy as ReturnType<typeof createInMemoryWorkbenchTenancyStore>
    ).registerPrincipal(TENANT.id, {
      id: "prn_carol",
      kind: "user",
      status: "active",
      refId: "prn_carol",
    });
    const asAlice = mountAs(createChatRoutes(deps), "prn_alice");
    const asCarol = mountAs(createChatRoutes(deps), "prn_carol");

    const { body } = await createWorkbench(asAlice, { kind: "workbench" });

    await asAlice.request(`/workbenches/${body.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ kind: "text", text: "@bob welcome!" }],
        invite: [{ kind: "person", principalId: "prn_bob", name: "Bob" }],
      }),
    });
    await asAlice.request(`/workbenches/${body.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/visibility": "members" }),
    });

    const carolRead = await asCarol.request(`/workbenches/${body.id}/messages`);
    expect(carolRead.status).toBe(404);
  });
});
