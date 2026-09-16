import { expect, test } from "bun:test";
import { createChatRoutes } from "../src/routes";
import { createInMemoryWorkbenchTenancyStore } from "../src/workbench-tenancy";
import { buildDeps, createWorkbench, mountAs, TENANT } from "./test-support";

test("the native owner is projected identically for owner and nonmember viewers", async () => {
  const tenancy = createInMemoryWorkbenchTenancyStore();
  tenancy.registerPrincipal(TENANT.id, {
    id: "prn_alice",
    refId: "prn_alice",
    kind: "user",
    status: "active",
  });
  const deps = buildDeps({
    tenancy,
    resolvePrincipalName: async () => "Alice",
  });
  const routes = createChatRoutes(deps);
  const alice = mountAs(routes, "prn_alice");
  await createWorkbench(alice, { kind: "workbench" });
  for (const viewer of [alice, mountAs(routes, "prn_bob")]) {
    const response = await viewer.request("/workbenches?kind=workbench");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [
        { owner: { address: "prn_alice", handle: "Alice" }, participants: [] },
      ],
    });
  }
});

test("an unresolved owner does not invent a participant", async () => {
  const app = mountAs(createChatRoutes(buildDeps()), "prn_alice");
  await createWorkbench(app, { kind: "workbench" });
  const response = await app.request("/workbenches?kind=workbench");
  expect(await response.json()).toMatchObject({
    items: [{ owner: null, participants: [] }],
  });
});
