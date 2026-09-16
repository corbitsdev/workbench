import { describe, expect, test } from "bun:test";
import { type } from "arktype";

import {
  buildNeedsList,
  childTenantStore,
  NeedsListSchema,
  parseNeedsList,
  type StringStorage,
} from "./needs-list";

function memoryStorage(initial: Record<string, string> = {}): StringStorage {
  const rows = new Map(Object.entries(initial));
  return {
    getItem: (key) => rows.get(key) ?? null,
    setItem: (key, value) => {
      rows.set(key, value);
    },
  };
}

describe("portable needs-list", () => {
  test("represents the primary tenant, top-level Myra, children, projections, and DM policy", () => {
    const manifest = buildNeedsList({
      account: { id: "usr_1", email: "ada@example.com", name: "Ada" },
      myraDefinitionRefId: "assistant",
      workbenches: [
        {
          localId: "atlas",
          slug: "ada-atlas",
          name: "Atlas",
          principals: [
            {
              kind: "user",
              refId: "usr_2",
              email: "bea@example.com",
              roles: ["member"],
            },
          ],
        },
      ],
    });

    expect(manifest).toMatchObject({
      version: 1,
      account: { id: "usr_1" },
      primaryTenant: { kind: "primary", want: "existing" },
      myra: {
        definitionRefId: "assistant",
        scope: "top-level",
        want: "running",
      },
      directMessages: {
        kind: "chat",
        onePer: "owned-top-level-workflow",
        projectedPrincipalKind: "workflow",
      },
    });
    expect(manifest.workbenches[0]).toMatchObject({
      kind: "workbench",
      parent: "primary",
      principals: [{ kind: "user", refId: "usr_2", status: "active" }],
    });
    expect(parseNeedsList(manifest) instanceof type.errors).toBe(false);
    expect(NeedsListSchema).toBeDefined();
  });

  test("rejects an unknown manifest version", () => {
    const manifest = buildNeedsList({
      account: { id: "usr_1", email: "ada@example.com", name: "Ada" },
      myraDefinitionRefId: "assistant",
    });
    expect(
      parseNeedsList({ ...manifest, version: 2 }) instanceof type.errors,
    ).toBe(true);
  });
});

describe("account and hub scoped child-tenant store", () => {
  test("does not leak ids between accounts or hubs and deduplicates local ids", () => {
    const storage = memoryStorage();
    const ada = childTenantStore(storage, "https://one.example", "usr_ada");
    const bea = childTenantStore(storage, "https://one.example", "usr_bea");
    const otherHub = childTenantStore(
      storage,
      "https://two.example",
      "usr_ada",
    );

    ada.record({
      localId: "dm:workflow_1",
      tenantId: "tnt_old",
      kind: "chat",
      principalRefId: "workflow_1",
    });
    ada.record({
      localId: "dm:workflow_1",
      tenantId: "tnt_current",
      kind: "chat",
      principalRefId: "workflow_1",
    });

    expect(ada.load()).toEqual([
      {
        localId: "dm:workflow_1",
        tenantId: "tnt_current",
        kind: "chat",
        principalRefId: "workflow_1",
      },
    ]);
    expect(bea.load()).toEqual([]);
    expect(otherHub.load()).toEqual([]);
  });

  test("treats corrupt client state as empty", () => {
    const storage = memoryStorage({
      "workbench.child-tenants:https%3A%2F%2Fone.example:usr_ada": "not json",
    });
    expect(
      childTenantStore(storage, "https://one.example", "usr_ada").load(),
    ).toEqual([]);
  });

  test("keeps valid rows when one row is corrupt", () => {
    const storage = memoryStorage({
      "workbench.child-tenants:https%3A%2F%2Fone.example:usr_ada":
        JSON.stringify([
          { localId: "atlas", tenantId: "tnt_atlas", kind: "workbench" },
          { localId: "", tenantId: "tnt_bad", kind: "workbench" },
          { localId: "dm:run_myra", tenantId: "tnt_dm", kind: "chat" },
          null,
        ]),
    });
    expect(
      childTenantStore(storage, "https://one.example", "usr_ada").load(),
    ).toEqual([
      { localId: "atlas", tenantId: "tnt_atlas", kind: "workbench" },
      { localId: "dm:run_myra", tenantId: "tnt_dm", kind: "chat" },
    ]);
  });
});
