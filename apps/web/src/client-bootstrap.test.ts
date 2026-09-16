import { expect, test } from "bun:test";

import { bootstrapClientSession } from "./client-bootstrap";
import type { StockHub } from "./needs-converge";

function memoryStorage() {
  const rows = new Map<string, string>();
  return {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => {
      rows.set(key, value);
    },
  };
}

test("session bootstrap drives the portable client manifest", async () => {
  const calls: string[] = [];
  const hub: StockHub = {
    listMyPrincipals: () => {
      calls.push("listMyPrincipals");
      return Promise.resolve([
        {
          principalId: "prn_user",
          tenantId: "tnt_primary",
          tenantName: "Ada",
          tenantSlug: "ada",
          kind: "user",
          status: "active",
          roles: [{ id: "role_owner", name: "owner" }],
        },
      ]);
    },
    getTenant: (id) => {
      calls.push(`getTenant:${id}`);
      return Promise.resolve({
        id,
        name: "Ada",
        slug: "ada",
        parentId: null,
      });
    },
    listPrincipals: (tenantId) => {
      calls.push(`listPrincipals:${tenantId}`);
      return Promise.resolve([
        {
          id: "prn_user",
          tenantId,
          kind: "user",
          refId: "usr_1",
          displayName: "Ada",
          email: "ada@example.com",
          status: "active",
          roles: [{ id: "role_owner", name: "owner" }],
        },
        {
          id: "prn_myra",
          tenantId,
          kind: "workflow",
          refId: "assistant",
          displayName: "Myra",
          status: "active",
          roles: [],
        },
      ]);
    },
    createTenant: () => Promise.reject(new Error("unexpected create")),
    inviteMember: () => Promise.reject(new Error("unexpected invite")),
    deployWorkflow: () => Promise.reject(new Error("unexpected deploy")),
  };

  const result = await bootstrapClientSession(
    { id: "usr_1", name: "Ada", email: "ada@example.com" },
    {
      hub,
      storage: memoryStorage(),
      hubScope: "https://hub.example",
    },
  );

  expect(result).toMatchObject({
    kind: "error",
    code: "stock-capability-missing",
    capability: "project-workflow-principal",
  });
  expect(calls).toEqual([
    "listMyPrincipals",
    "getTenant:tnt_primary",
    "listPrincipals:tnt_primary",
  ]);
});
