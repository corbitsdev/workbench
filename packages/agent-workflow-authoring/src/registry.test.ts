import { expect, test } from "bun:test";
import type {
  ConditionRegistry,
  GrantStore,
  GrantRule,
} from "@intx/types/authz";
import { AssetServiceError, type AssetService } from "@intx/hub-sessions";
import type { DB } from "@intx/db";

import {
  createWorkflowAuthorRegistry,
  WorkflowAuthorError,
  type CreateWorkflowAuthorRegistryDeps,
} from "./registry";

function allowGrant(action: string): GrantRule {
  return {
    id: `g_${action}`,
    resource: "asset:*",
    action,
    effect: "allow",
    origin: "system",
    conditions: null,
    expiresAt: null,
    roleId: null,
    principalId: null,
  };
}

function fakeGrantStore(grants: readonly GrantRule[]): GrantStore {
  return {
    collectGrants: async () => [...grants],
    collectGrantsInChain: async () => [...grants],
  };
}

const conditionRegistry: ConditionRegistry = {};

function fakeAssetService(overrides: Partial<AssetService> = {}): AssetService {
  return {
    createAsset: async (params) => ({
      id: "asset_1",
      tenantId: params.tenantId,
      kind: params.kind,
      name: params.name,
      displayName: params.displayName ?? null,
      creatorPrincipalId: params.creatorPrincipalId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    populateAsset: async () => ({ commitSha: "sha_1" }),
    readAssetBlob: async () => {
      throw new Error("not implemented in fake");
    },
    listAssetBlobs: async () => [],
    ...overrides,
  };
}

type AssetRow = {
  id: string;
  tenantId: string;
  kind: string;
  name: string;
};

/** A `db.query.asset.findFirst` fake resolving to whatever the test wires
 * up — standing in for the real drizzle `and(eq(id), eq(tenantId),
 * eq(kind))` lookup registry.ts performs. A row from another tenant (or a
 * nonexistent id) never resolves through that real query, so the fake
 * models that outcome as `undefined` directly rather than re-implementing
 * drizzle's where-clause evaluation. */
function fakeDb(row: AssetRow | undefined): DB["db"] {
  return {
    query: {
      asset: {
        findFirst: async () => row,
      },
    },
  } as unknown as DB["db"];
}

function deps(
  overrides: Partial<CreateWorkflowAuthorRegistryDeps> = {},
): CreateWorkflowAuthorRegistryDeps {
  return {
    db: fakeDb(undefined),
    assetService: fakeAssetService(),
    grantStore: fakeGrantStore([allowGrant("create"), allowGrant("write")]),
    conditionRegistry,
    ...overrides,
  };
}

const caller = { tenantId: "tenant_1", principalId: "principal_1" };

test("author publishes a workflow codebase as a workflow-kind asset", async () => {
  let created: { kind: string; tenantId: string } | undefined;
  let populated: { assetId: string; files: unknown } | undefined;
  const assetService = fakeAssetService({
    createAsset: async (params) => {
      created = { kind: params.kind, tenantId: params.tenantId };
      return {
        id: "asset_1",
        tenantId: params.tenantId,
        kind: params.kind,
        name: params.name,
        displayName: params.displayName ?? null,
        creatorPrincipalId: params.creatorPrincipalId ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
    populateAsset: async (params) => {
      populated = { assetId: params.assetId, files: params.tree.files };
      return { commitSha: "sha_abc" };
    },
  });

  const registry = createWorkflowAuthorRegistry(deps({ assetService }));
  const summary = await registry.author(caller, {
    name: "daily-digest",
    files: { "package.json": '{"interchange":{"workflow":"index.ts"}}' },
  });

  expect(summary).toEqual({
    assetId: "asset_1",
    name: "daily-digest",
    commitSha: "sha_abc",
  });
  expect(created).toEqual({ kind: "workflow", tenantId: "tenant_1" });
  expect(populated?.assetId).toBe("asset_1");
});

test("author rejects a malformed name before ever calling the asset service", async () => {
  let called = false;
  const assetService = fakeAssetService({
    createAsset: async () => {
      called = true;
      throw new Error("must not be called");
    },
  });
  const registry = createWorkflowAuthorRegistry(deps({ assetService }));

  await expect(
    registry.author(caller, { name: "Not Kebab!", files: { "a.ts": "x" } }),
  ).rejects.toMatchObject({ reason: "invalid" });
  expect(called).toBe(false);
});

test("author refuses when the principal's grants do not include asset:*/create", async () => {
  let called = false;
  const assetService = fakeAssetService({
    createAsset: async () => {
      called = true;
      throw new Error("must not be called");
    },
  });
  const registry = createWorkflowAuthorRegistry(
    deps({ assetService, grantStore: fakeGrantStore([]) }),
  );

  const err = await registry
    .author(caller, { name: "daily-digest", files: { "a.ts": "x" } })
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WorkflowAuthorError);
  expect((err as WorkflowAuthorError).reason).toBe("forbidden");
  expect(called).toBe(false);
});

test("author surfaces a rejected codebase (e.g. missing interchange.workflow entry) as an invalid-source error, not a raw throw", async () => {
  const assetService = fakeAssetService({
    populateAsset: async () => {
      throw new AssetServiceError(
        "path_violation",
        'package.json must declare a non-empty "interchange.workflow" entry',
      );
    },
  });
  const registry = createWorkflowAuthorRegistry(deps({ assetService }));

  const err = await registry
    .author(caller, { name: "daily-digest", files: { "package.json": "{}" } })
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WorkflowAuthorError);
  expect((err as WorkflowAuthorError).reason).toBe("invalid");
  expect((err as Error).message).toMatch(/interchange\.workflow/);
});

test("republish refuses an asset id that does not resolve in the caller's own tenant", async () => {
  let populateCalled = false;
  const assetService = fakeAssetService({
    populateAsset: async () => {
      populateCalled = true;
      return { commitSha: "sha_x" };
    },
  });
  // No row resolves — the same outcome the real tenant-scoped query
  // produces for another tenant's asset id, or an id that never existed.
  const registry = createWorkflowAuthorRegistry(
    deps({ assetService, db: fakeDb(undefined) }),
  );

  const err = await registry
    .republish(caller, "asset_from_another_tenant", { files: { "a.ts": "x" } })
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WorkflowAuthorError);
  expect((err as WorkflowAuthorError).reason).toBe("not_found");
  expect(populateCalled).toBe(false);
});

test("republish writes a new commit once the asset resolves in-tenant and the grant allows write", async () => {
  const row: AssetRow = {
    id: "asset_1",
    tenantId: "tenant_1",
    kind: "workflow",
    name: "daily-digest",
  };
  let populatedAssetId: string | undefined;
  const assetService = fakeAssetService({
    populateAsset: async (params) => {
      populatedAssetId = params.assetId;
      return { commitSha: "sha_new" };
    },
  });
  const registry = createWorkflowAuthorRegistry(
    deps({ assetService, db: fakeDb(row) }),
  );

  const summary = await registry.republish(caller, "asset_1", {
    files: { "index.ts": "export {};" },
  });
  expect(summary).toEqual({
    assetId: "asset_1",
    name: "daily-digest",
    commitSha: "sha_new",
  });
  expect(populatedAssetId).toBe("asset_1");
});

test("republish refuses when the grant store has no matching write grant", async () => {
  const row: AssetRow = {
    id: "asset_1",
    tenantId: "tenant_1",
    kind: "workflow",
    name: "daily-digest",
  };
  let populateCalled = false;
  const assetService = fakeAssetService({
    populateAsset: async () => {
      populateCalled = true;
      return { commitSha: "sha_new" };
    },
  });
  const registry = createWorkflowAuthorRegistry(
    deps({
      assetService,
      db: fakeDb(row),
      // Only "create" is granted, never "write" — a principal that can
      // author brand-new workflows but not overwrite an existing one.
      grantStore: fakeGrantStore([allowGrant("create")]),
    }),
  );

  const err = await registry
    .republish(caller, "asset_1", { files: { "index.ts": "x" } })
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WorkflowAuthorError);
  expect((err as WorkflowAuthorError).reason).toBe("forbidden");
  expect(populateCalled).toBe(false);
});
