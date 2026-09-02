import { expect, test } from "bun:test";
import type {
  ConditionRegistry,
  GrantStore,
  GrantRule,
} from "@intx/types/authz";
import { AssetServiceError, type AssetService } from "@intx/hub-sessions";
import type { DB } from "@intx/db";

import { WorkflowAuthorError } from "./errors";
import {
  createWorkflowAuthorRegistry,
  type CreateWorkflowAuthorRegistryDeps,
  type WorkflowAuthorRepoReads,
  type WorkflowDeployer,
} from "./registry";

const MANIFEST = JSON.stringify({
  name: "daily-digest",
  version: "0.0.1",
  type: "module",
  interchange: { workflow: "./workflow.ts" },
});

const ENTRY = "export default {};\n";

function sourceTree(
  extra: Record<string, string> = {},
): Record<string, string> {
  return { "package.json": MANIFEST, "workflow.ts": ENTRY, ...extra };
}

function fakeRepoStore(
  overrides: Partial<WorkflowAuthorRepoReads> = {},
): WorkflowAuthorRepoReads {
  return {
    resolveRef: async () => "sha_head",
    openCommittedReads: async () => null,
    openCommittedReadsAtCommit: async () => null,
    ...overrides,
  };
}

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

function fakeDeployer(
  overrides: Partial<WorkflowDeployer> = {},
): WorkflowDeployer {
  return {
    deploy: async () => {
      throw new Error("deploy not stubbed");
    },
    ...overrides,
  };
}

function deps(
  overrides: Partial<CreateWorkflowAuthorRegistryDeps> = {},
): CreateWorkflowAuthorRegistryDeps {
  return {
    db: fakeDb(undefined),
    assetService: fakeAssetService(),
    repoStore: fakeRepoStore(),
    grantStore: fakeGrantStore([
      allowGrant("create"),
      allowGrant("write"),
      allowGrant("read"),
    ]),
    conditionRegistry,
    deployer: fakeDeployer(),
    ...overrides,
  };
}

function workflowGrant(action: string): GrantRule {
  return {
    id: `g_workflow_${action}`,
    resource: "workflow:*",
    action,
    effect: "allow",
    origin: "system",
    conditions: null,
    expiresAt: null,
    roleId: null,
    principalId: null,
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
    files: sourceTree(),
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
    registry.author(caller, { name: "Not Kebab!", files: sourceTree() }),
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
    .author(caller, { name: "daily-digest", files: sourceTree() })
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WorkflowAuthorError);
  expect((err as WorkflowAuthorError).reason).toBe("forbidden");
  expect(called).toBe(false);
});

test("author rejects a tree with no interchange.workflow entry before any asset is created", async () => {
  let created = false;
  const assetService = fakeAssetService({
    createAsset: async () => {
      created = true;
      throw new Error("must not be called");
    },
  });
  const registry = createWorkflowAuthorRegistry(deps({ assetService }));

  const err = await registry
    .author(caller, {
      name: "daily-digest",
      files: { "package.json": '{"name":"x","version":"0.0.1"}' },
    })
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WorkflowAuthorError);
  expect((err as WorkflowAuthorError).reason).toBe("invalid");
  expect((err as Error).message).toMatch(/interchange\.workflow/);
  expect(created).toBe(false);
});

test("author surfaces a substrate push rejection as an invalid-source error, not a raw throw", async () => {
  const assetService = fakeAssetService({
    populateAsset: async () => {
      throw new AssetServiceError(
        "path_violation",
        "a committed top-level node_modules directory is not allowed",
      );
    },
  });
  const registry = createWorkflowAuthorRegistry(deps({ assetService }));

  const err = await registry
    .author(caller, { name: "daily-digest", files: sourceTree() })
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WorkflowAuthorError);
  expect((err as WorkflowAuthorError).reason).toBe("invalid");
  expect((err as Error).message).toMatch(/node_modules/);
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
    .republish(caller, "asset_from_another_tenant", { files: sourceTree() })
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
    files: sourceTree(),
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
    .republish(caller, "asset_1", { files: sourceTree() })
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WorkflowAuthorError);
  expect((err as WorkflowAuthorError).reason).toBe("forbidden");
  expect(populateCalled).toBe(false);
});

const ownRow: AssetRow = {
  id: "asset_1",
  tenantId: "tenant_1",
  kind: "workflow",
  name: "daily-digest",
};

test("republish with a stale expectedHeadSha is refused as a conflict carrying the current head, and writes nothing", async () => {
  let populateCalled = false;
  const registry = createWorkflowAuthorRegistry(
    deps({
      db: fakeDb(ownRow),
      assetService: fakeAssetService({
        populateAsset: async () => {
          populateCalled = true;
          return { commitSha: "sha_new" };
        },
      }),
      repoStore: fakeRepoStore({ resolveRef: async () => "sha_current" }),
    }),
  );

  const err = await registry
    .republish(caller, "asset_1", {
      files: sourceTree(),
      expectedHeadSha: "sha_stale",
    })
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WorkflowAuthorError);
  expect((err as WorkflowAuthorError).reason).toBe("conflict");
  expect((err as WorkflowAuthorError).currentHeadSha).toBe("sha_current");
  expect(populateCalled).toBe(false);
});

test("republish with a matching expectedHeadSha proceeds", async () => {
  const registry = createWorkflowAuthorRegistry(
    deps({
      db: fakeDb(ownRow),
      repoStore: fakeRepoStore({ resolveRef: async () => "sha_current" }),
    }),
  );
  const summary = await registry.republish(caller, "asset_1", {
    files: sourceTree(),
    expectedHeadSha: "sha_current",
  });
  expect(summary.commitSha).toBe("sha_1");
});

test("republish rejects a traversal path before the grant check or any write", async () => {
  let authorized = false;
  const registry = createWorkflowAuthorRegistry(
    deps({
      db: fakeDb(ownRow),
      grantStore: {
        collectGrants: async () => {
          authorized = true;
          return [allowGrant("write")];
        },
        collectGrantsInChain: async () => [allowGrant("write")],
      },
    }),
  );
  const err = await registry
    .republish(caller, "asset_1", {
      files: sourceTree({ "../escape.ts": "x" }),
    })
    .catch((e: unknown) => e);
  expect((err as WorkflowAuthorError).reason).toBe("invalid");
  expect(authorized).toBe(false);
});

test("readSource walks the whole committed tree, including subdirectories, and reports the head sha", async () => {
  const blobs: Record<string, string> = {
    oid_pkg: MANIFEST,
    oid_entry: ENTRY,
    oid_helper: "export const x = 1;\n",
  };
  const registry = createWorkflowAuthorRegistry(
    deps({
      db: fakeDb(ownRow),
      repoStore: fakeRepoStore({
        resolveRef: async () => "sha_head",
        openCommittedReadsAtCommit: async () => ({
          listDir: async (dir) =>
            dir === ""
              ? [
                  { name: "package.json", oid: "oid_pkg", type: "blob" },
                  { name: "workflow.ts", oid: "oid_entry", type: "blob" },
                  { name: "lib", oid: "oid_lib", type: "tree" },
                ]
              : dir === "lib"
                ? [{ name: "helper.ts", oid: "oid_helper", type: "blob" }]
                : [],
          readBlobByOid: async (oid) =>
            new TextEncoder().encode(blobs[oid] ?? ""),
          treeOid: async () => null,
        }),
      }),
    }),
  );

  const snapshot = await registry.readSource(caller, "asset_1");
  expect(snapshot).toEqual({
    assetId: "asset_1",
    name: "daily-digest",
    headSha: "sha_head",
    files: {
      "package.json": MANIFEST,
      "workflow.ts": ENTRY,
      "lib/helper.ts": "export const x = 1;\n",
    },
  });
});

test("readSource refuses without an asset read grant", async () => {
  const registry = createWorkflowAuthorRegistry(
    deps({
      db: fakeDb(ownRow),
      grantStore: fakeGrantStore([allowGrant("write")]),
    }),
  );
  const err = await registry
    .readSource(caller, "asset_1")
    .catch((e: unknown) => e);
  expect((err as WorkflowAuthorError).reason).toBe("forbidden");
});

test("deploy refuses an asset id that does not resolve in the caller's own tenant", async () => {
  let deployCalled = false;
  const registry = createWorkflowAuthorRegistry(
    deps({
      db: fakeDb(undefined),
      grantStore: fakeGrantStore([workflowGrant("create")]),
      deployer: fakeDeployer({
        deploy: async () => {
          deployCalled = true;
          throw new Error("must not be called");
        },
      }),
    }),
  );
  const err = await registry
    .deploy(caller, "asset_from_another_tenant", {
      commitSha: "sha_1",
      entry: "./workflow.ts",
    })
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WorkflowAuthorError);
  expect((err as WorkflowAuthorError).reason).toBe("not_found");
  expect(deployCalled).toBe(false);
});

test("deploy refuses when the grant store has no matching workflow:*/create grant", async () => {
  let deployCalled = false;
  const registry = createWorkflowAuthorRegistry(
    deps({
      db: fakeDb(ownRow),
      grantStore: fakeGrantStore([allowGrant("create")]), // asset:*/create, not workflow:*/create
      deployer: fakeDeployer({
        deploy: async () => {
          deployCalled = true;
          throw new Error("must not be called");
        },
      }),
    }),
  );
  const err = await registry
    .deploy(caller, "asset_1", { commitSha: "sha_1", entry: "./workflow.ts" })
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WorkflowAuthorError);
  expect((err as WorkflowAuthorError).reason).toBe("forbidden");
  expect(deployCalled).toBe(false);
});

test("deploy calls the injected deployer with the caller's own scope once authorized", async () => {
  let seen: unknown;
  const registry = createWorkflowAuthorRegistry(
    deps({
      db: fakeDb(ownRow),
      grantStore: fakeGrantStore([workflowGrant("create")]),
      deployer: fakeDeployer({
        deploy: async (params) => {
          seen = params;
          return {
            deploymentId: "run_1",
            definitionAssetId: "asset_1",
            status: "deployed",
          };
        },
      }),
    }),
  );
  const result = await registry.deploy(caller, "asset_1", {
    commitSha: "sha_1",
    entry: "./workflow.ts",
  });
  expect(result).toEqual({
    deploymentId: "run_1",
    definitionAssetId: "asset_1",
    status: "deployed",
  });
  expect(seen).toEqual({
    tenantId: "tenant_1",
    principalId: "principal_1",
    assetId: "asset_1",
    commitSha: "sha_1",
    entry: "./workflow.ts",
  });
});
