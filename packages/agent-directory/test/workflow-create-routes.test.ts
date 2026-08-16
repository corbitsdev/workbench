// Route-level tests for the workflow-run-authenticated agent-creation
// surface: authentication, the fail-closed tool-package-pin inventory
// check, the create happy path (mirroring `./routes.ts`'s `POST /`
// materialization), and the tenant-scoped conversational-agent listing.
// Mirrors `workflow-capability-routes.test.ts`'s fakes.

import { expect, test } from "bun:test";
import { Hono } from "hono";

import type { AssetService } from "@intx/hub-sessions";
import type { DB } from "@intx/db";

import {
  createWorkflowAgentCreateRoutes,
  type CreateWorkflowAgentCreateRoutesDeps,
} from "../src/workflow-create-routes";
import type {
  WorkflowCapabilityRunScope,
  WorkflowRunAuthenticator,
} from "../src/workflow-capability-routes";
import type { PinnedSkillIndexResolver } from "../src/routes";
import { createInMemoryDefinitionSkillsStore } from "../src/skills-store";
import type { CapabilityInventoryProvider } from "../src/capability-inventory";

const TENANT_ID = "tnt_1";
const RUN_ID = "run_1";
const SIDECAR_TOKEN = "sidecar-token";
const RUN_ADDRESS = `${RUN_ID}@example.com`;

const fakeCapabilityInventory: CapabilityInventoryProvider = {
  resolve: () =>
    Promise.resolve({
      toolPackages: [{ name: "@corbits/memory-tools" }],
      skills: [{ name: "research" }],
      models: [{ canonicalName: "anthropic/claude-sonnet" }],
    }),
};

const fakeSkillIndex: PinnedSkillIndexResolver = {
  resolve: (_tenantId, _principalId, names) =>
    Promise.resolve(
      names.map((name) => ({ name, description: `What ${name} does.` })),
    ),
};

function fakeAssetService(overrides: Partial<AssetService> = {}): AssetService {
  return {
    createAsset: () =>
      Promise.resolve({ id: "ast_new", tenantId: TENANT_ID, kind: "workflow" }),
    populateAsset: () => Promise.resolve({ commitSha: "deadbeef" }),
    readAssetBlob: () => {
      throw new Error("not used in these tests");
    },
    listAssetBlobs: () => {
      throw new Error("not used in these tests");
    },
    ...overrides,
  } as unknown as AssetService;
}

type FakeDefinitionRow = {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  status: string;
  currentVersion: number;
  assetId: string | null;
};

// `POST /definitions` reuses `createAgentDefinitionCore`, whose write
// path continues through populateAsset -> ensureWorkflowDefinitionForAsset
// (`@intx/hub-sessions`) -> read-back — that helper drives the drizzle
// handle directly (`.select().from().where().limit()`,
// `.insert().values().onConflictDoNothing().returning()`) rather than
// through `db.query.*`, so the fake below provides just enough of that
// chainable shape too, mirroring `routes.test.ts`'s own `fakeDb`.
function fakeDb(
  opts: {
    definitions?: FakeDefinitionRow[];
    createdRow?: FakeDefinitionRow;
  } = {},
): DB["db"] {
  const createdRow: FakeDefinitionRow = opts.createdRow ?? {
    id: "def_new",
    tenantId: TENANT_ID,
    name: "research-buddy",
    description: null,
    status: "deployed",
    currentVersion: 1,
    assetId: "ast_new",
  };
  const definitions = opts.definitions ?? [createdRow];
  const selectResult = [
    {
      tenantId: TENANT_ID,
      creatorPrincipalId: null,
      name: createdRow.name,
      displayName: createdRow.name,
    },
  ];

  return {
    query: {
      tenant: {
        findFirst: async () => ({ id: TENANT_ID, domain: "acme.example" }),
      },
      asset: {
        findFirst: async () => undefined,
      },
      workflowDefinition: {
        findFirst: async () => createdRow,
        findMany: async () => definitions,
      },
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(selectResult),
        }),
      }),
    }),
    insert: () => ({
      values: () => {
        const chain: Record<string, unknown> = {
          onConflictDoNothing: () => chain,
          returning: () => Promise.resolve([{ id: createdRow.id }]),
          then: (onFulfilled: unknown) =>
            Promise.resolve([]).then(onFulfilled as never),
        };
        return chain;
      },
    }),
  } as unknown as DB["db"];
}

const authenticateAsRun: WorkflowRunAuthenticator = {
  resolve: (token, address) =>
    Promise.resolve(
      token === SIDECAR_TOKEN && address === RUN_ADDRESS
        ? ({
            tenantId: TENANT_ID,
            principalId: "prn_1",
            runId: RUN_ID,
          } satisfies WorkflowCapabilityRunScope)
        : null,
    ),
};

function buildApp(
  opts: Partial<CreateWorkflowAgentCreateRoutesDeps> = {},
): Hono {
  return createWorkflowAgentCreateRoutes({
    db: opts.db ?? fakeDb(),
    assetService: opts.assetService ?? fakeAssetService(),
    skillIndex: opts.skillIndex ?? fakeSkillIndex,
    skillsStore: opts.skillsStore ?? createInMemoryDefinitionSkillsStore(),
    capabilityInventory: opts.capabilityInventory ?? fakeCapabilityInventory,
    authenticator: opts.authenticator ?? authenticateAsRun,
  }) as unknown as Hono;
}

const AUTH_HEADERS = {
  authorization: `Bearer ${SIDECAR_TOKEN}`,
  "x-workflow-run-address": RUN_ADDRESS,
};

test("POST /definitions is a 401 without a recognized run credential", async () => {
  const app = buildApp();
  const response = await app.request("/definitions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Research Buddy",
      handle: "research-buddy",
      systemPrompt: "You are a careful research assistant.",
    }),
  });
  expect(response.status).toBe(401);
});

test("GET /definitions is a 401 without a recognized run credential", async () => {
  const app = buildApp();
  const response = await app.request("/definitions");
  expect(response.status).toBe(401);
});

test("creates a definition and returns it, reusing the same materialization the tenant-session route uses", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const app = buildApp({
    assetService: fakeAssetService({
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
  });
  const response = await app.request("/definitions", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({
      name: "Research Buddy",
      handle: "research-buddy",
      systemPrompt: "You are a careful research assistant.",
    }),
  });
  expect(response.status).toBe(201);
  expect(Object.keys(writtenFiles ?? {})).toEqual(["workflow.json"]);
  const body = (await response.json()) as { id: string; name: string };
  expect(body.id).toBe("def_new");
});

test("a toolPackagePins entry outside the tenant's inventory is a 400, never written", async () => {
  let populateCalled = false;
  const app = buildApp({
    assetService: fakeAssetService({
      populateAsset: () => {
        populateCalled = true;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
  });
  const response = await app.request("/definitions", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({
      name: "Research Buddy",
      handle: "research-buddy",
      systemPrompt: "You are a careful research assistant.",
      toolPackagePins: ["@corbits/nonexistent-tools"],
    }),
  });
  expect(response.status).toBe(400);
  expect(populateCalled).toBe(false);
});

test("a toolPackagePins entry the tenant's inventory offers is pinned onto the created definition", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const app = buildApp({
    assetService: fakeAssetService({
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
  });
  const response = await app.request("/definitions", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({
      name: "Research Buddy",
      handle: "research-buddy",
      systemPrompt: "You are a careful research assistant.",
      toolPackagePins: ["@corbits/memory-tools"],
    }),
  });
  expect(response.status).toBe(201);
  const written = writtenFiles?.["workflow.json"];
  expect(typeof written).toBe("string");
  expect(written as string).toContain("@corbits/memory-tools");
});

test("an invalid body is a 400", async () => {
  const app = buildApp();
  const response = await app.request("/definitions", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({ name: "", handle: "Bad Handle!" }),
  });
  expect(response.status).toBe(400);
});

test("GET /definitions lists conversational agents deployed in the caller's tenant", async () => {
  const app = buildApp({
    db: fakeDb({
      definitions: [
        {
          id: "def_1",
          tenantId: TENANT_ID,
          name: "research-buddy",
          description: "A careful researcher",
          status: "deployed",
          currentVersion: 1,
          assetId: "ast_1",
        },
        {
          id: "def_2",
          tenantId: TENANT_ID,
          name: "ins-0f1e2d3c4b5a69788796a5b4c3d2e1f0",
          description: null,
          status: "deployed",
          currentVersion: 1,
          assetId: "ast_2",
        },
      ],
    }),
  });
  const response = await app.request("/definitions", { headers: AUTH_HEADERS });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    definitions: { id: string; name: string; description: string | null }[];
  };
  expect(body.definitions).toEqual([
    {
      id: "def_1",
      name: "research-buddy",
      description: "A careful researcher",
    },
  ]);
});
