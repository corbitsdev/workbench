// Route-level tests for the workflow-run-authenticated capabilities
// surface: authentication, the own-definition-only constraint, the
// fail-closed inventory check, and the versioned-add + read-back happy
// path. Mirrors `routes.test.ts`'s fakes for the tenant-session
// `POST /:definitionId/capabilities` route this surface parallels.

import { expect, test } from "bun:test";
import { Hono } from "hono";

import type { AssetService } from "@intx/hub-sessions";
import type { DB } from "@intx/db";

import {
  buildAgentDefinitionWorkflow,
  serializeAgentDefinitionWorkflow,
} from "../src/agent-workflow";
import {
  createWorkflowCapabilityRoutes,
  type WorkflowCapabilityRunScope,
  type WorkflowRunAuthenticator,
} from "../src/workflow-capability-routes";
import type { PinnedSkillIndexResolver } from "../src/routes";
import {
  createInMemoryDefinitionSkillsStore,
  type DefinitionSkillsStore,
} from "../src/skills-store";
import type { CapabilityInventoryProvider } from "../src/capability-inventory";

const TENANT_ID = "tnt_1";
const RUN_ID = "run_1";
const OWN_DEFINITION_ID = "def_1";
const OTHER_DEFINITION_ID = "def_2";
const SIDECAR_TOKEN = "sidecar-token";
const RUN_ADDRESS = `${RUN_ID}@example.com`;

const fakeCapabilityInventory: CapabilityInventoryProvider = {
  resolve: () =>
    Promise.resolve({
      toolPackages: [{ name: "@corbits/capability-tools" }],
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

function storedDefinitionBytes(): Uint8Array {
  return new TextEncoder().encode(
    serializeAgentDefinitionWorkflow(
      buildAgentDefinitionWorkflow({
        handle: "research-buddy",
        tenantDomain: "acme.example",
        description: "",
        systemPrompt: "You are a careful research assistant.",
      }),
    ),
  );
}

/** A `readAssetBlob` that always answers `workflow.json` — pinned skills
 * no longer live in the asset tree, so a test that needs a definition's
 * skills seeds a `DefinitionSkillsStore` directly instead. */
function readAssetBlobFor(
  workflowBytes: Uint8Array,
): AssetService["readAssetBlob"] {
  return () => Promise.resolve(workflowBytes);
}

function fakeAssetService(overrides: Partial<AssetService> = {}): AssetService {
  return {
    createAsset: () => {
      throw new Error("createAsset not stubbed for this test");
    },
    populateAsset: () => Promise.resolve({ commitSha: "deadbeef" }),
    readAssetBlob: () => {
      throw new Error("not used in these tests");
    },
    listAssetBlobs: () => {
      throw new Error("not used in these tests");
    },
    ...overrides,
  };
}

function fakeDb(): DB["db"] {
  return {
    query: {
      workflowRun: {
        findFirst: async () => ({
          id: RUN_ID,
          definitionId: OWN_DEFINITION_ID,
        }),
      },
      workflowDefinition: {
        findFirst: async () => ({
          id: OWN_DEFINITION_ID,
          tenantId: TENANT_ID,
          assetId: "ast_1",
          name: "research-buddy",
        }),
      },
    },
  } as unknown as DB["db"];
}

const authenticateAsOwnRun: WorkflowRunAuthenticator = {
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

function buildApp(opts: {
  assetService?: AssetService;
  db?: DB["db"];
  authenticator?: WorkflowRunAuthenticator;
  capabilityInventory?: CapabilityInventoryProvider;
  skillsStore?: DefinitionSkillsStore;
}): Hono {
  return createWorkflowCapabilityRoutes({
    db: opts.db ?? fakeDb(),
    assetService: opts.assetService ?? fakeAssetService(),
    skillIndex: fakeSkillIndex,
    skillsStore: opts.skillsStore ?? createInMemoryDefinitionSkillsStore(),
    capabilityInventory: opts.capabilityInventory ?? fakeCapabilityInventory,
    authenticator: opts.authenticator ?? authenticateAsOwnRun,
  }) as unknown as Hono;
}

async function postCapability(
  app: Hono,
  definitionId: string,
  body: unknown,
  headers: Record<string, string> = {
    authorization: `Bearer ${SIDECAR_TOKEN}`,
    "x-workflow-run-address": RUN_ADDRESS,
  },
): Promise<Response> {
  return app.request(`/${definitionId}/capabilities`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("a missing or unrecognized bearer token / run address is a 401", async () => {
  const app = buildApp({});
  const response = await postCapability(
    app,
    OWN_DEFINITION_ID,
    { kind: "toolPackage", name: "@corbits/capability-tools" },
    {},
  );
  expect(response.status).toBe(401);
});

test("a run targeting another definition's capabilities is a 403", async () => {
  const app = buildApp({});
  const response = await postCapability(app, OTHER_DEFINITION_ID, {
    kind: "toolPackage",
    name: "@corbits/capability-tools",
  });
  expect(response.status).toBe(403);
});

test("a run may add a capability to its own definition without any grant check", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  let writtenMessage: string | undefined;
  const app = buildApp({
    assetService: fakeAssetService({
      readAssetBlob: readAssetBlobFor(storedDefinitionBytes()),
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        writtenMessage = params.tree.message;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
  });
  const response = await postCapability(app, OWN_DEFINITION_ID, {
    kind: "toolPackage",
    name: "@corbits/capability-tools",
  });
  expect(response.status).toBe(200);
  expect(Object.keys(writtenFiles ?? {})).toEqual(["workflow.json"]);
  expect(writtenMessage).toBe(
    "Add @corbits/capability-tools to research-buddy",
  );
  const body = (await response.json()) as {
    toolPackagePins: { name: string; version: string }[];
  };
  expect(body.toolPackagePins).toEqual([
    { name: "@corbits/capability-tools", version: "*" },
  ]);
});

test("adding a capability the tenant's inventory doesn't offer is a 400, never written", async () => {
  let populateCalled = false;
  const app = buildApp({
    assetService: fakeAssetService({
      readAssetBlob: readAssetBlobFor(storedDefinitionBytes()),
      populateAsset: () => {
        populateCalled = true;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
  });
  const response = await postCapability(app, OWN_DEFINITION_ID, {
    kind: "toolPackage",
    name: "@corbits/nonexistent-tools",
  });
  expect(response.status).toBe(400);
  expect(populateCalled).toBe(false);
});

test("adding a skill merges it additively into the skills store and re-indexes the prompt", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const skillsStore = createInMemoryDefinitionSkillsStore();
  const app = buildApp({
    assetService: fakeAssetService({
      readAssetBlob: readAssetBlobFor(storedDefinitionBytes()),
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    skillsStore,
  });
  const response = await postCapability(app, OWN_DEFINITION_ID, {
    kind: "skill",
    name: "research",
  });
  expect(response.status).toBe(200);
  expect(Object.keys(writtenFiles ?? {})).toEqual(["workflow.json"]);
  expect(await skillsStore.getSkills("ast_1")).toEqual(["research"]);
  const body = (await response.json()) as { skills: string[] };
  expect(body.skills).toEqual(["research"]);
});

test("setting a model in the tenant's catalog writes a single named commit", async () => {
  let writtenMessage: string | undefined;
  const app = buildApp({
    assetService: fakeAssetService({
      readAssetBlob: readAssetBlobFor(storedDefinitionBytes()),
      populateAsset: (params) => {
        writtenMessage = params.tree.message;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
  });
  const response = await postCapability(app, OWN_DEFINITION_ID, {
    kind: "model",
    canonicalName: "anthropic/claude-sonnet",
  });
  expect(response.status).toBe(200);
  expect(writtenMessage).toBe(
    "Set research-buddy's model to anthropic/claude-sonnet",
  );
  const body = (await response.json()) as { model?: string };
  expect(body.model).toBe("anthropic/claude-sonnet");
});

test("capabilities route 404s for an unknown definition even when it is the caller's own", async () => {
  const app = buildApp({
    db: {
      query: {
        workflowRun: {
          findFirst: async () => ({
            id: RUN_ID,
            definitionId: OWN_DEFINITION_ID,
          }),
        },
        workflowDefinition: { findFirst: async () => undefined },
      },
    } as unknown as DB["db"],
  });
  const response = await postCapability(app, OWN_DEFINITION_ID, {
    kind: "model",
    canonicalName: "anthropic/claude-sonnet",
  });
  expect(response.status).toBe(404);
});

test("GET /inventory serves the resolved scope's tenant inventory", async () => {
  const app = buildApp({});
  const response = await app.request("/inventory", {
    headers: {
      authorization: `Bearer ${SIDECAR_TOKEN}`,
      "x-workflow-run-address": RUN_ADDRESS,
    },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    toolPackages: { name: string }[];
  };
  expect(body.toolPackages).toEqual([{ name: "@corbits/capability-tools" }]);
});

test("GET /inventory is a 401 without a recognized run credential", async () => {
  const app = buildApp({});
  const response = await app.request("/inventory");
  expect(response.status).toBe(401);
});
