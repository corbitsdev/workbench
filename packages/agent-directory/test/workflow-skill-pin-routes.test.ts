// Route-level tests for the workflow-run-authenticated skill-pin
// surface: authentication, the tenant-membership + host guard, the
// happy-path pin, and idempotency. Fakes mirror
// `workflow-capability-routes.test.ts`'s.

import { expect, test } from "bun:test";
import { Hono } from "hono";

import type { AssetService } from "@intx/hub-sessions";
import type { DB } from "@intx/db";

import {
  buildAgentDefinitionWorkflow,
  serializeAgentDefinitionWorkflow,
} from "../src/agent-workflow";
import {
  createWorkflowSkillPinRoutes,
  type WorkflowSkillPinRunScope,
  type WorkflowRunAuthenticator,
} from "../src/workflow-skill-pin-routes";
import type { PinnedSkillIndexResolver } from "../src/routes";
import {
  createInMemoryDefinitionSkillsStore,
  type DefinitionSkillsStore,
} from "../src/skills-store";

const TENANT_ID = "tnt_1";
const OTHER_TENANT_ID = "tnt_2";
const TARGET_DEFINITION_ID = "def_1";
const WORKBENCH_HOST_DEFINITION_ID = "def_host";
const SIDECAR_TOKEN = "sidecar-token";
const RUN_ADDRESS = "run_1@example.com";

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
    readAssetBlob: readAssetBlobFor(storedDefinitionBytes()),
    listAssetBlobs: () => {
      throw new Error("not used in these tests");
    },
    ...overrides,
  };
}

/** A fake `db.query.workflowDefinition.findFirst` that answers by id +
 * tenantId. The fake doesn't parse drizzle's `where` expression tree —
 * it filters the seeded rows directly against the module-level "current
 * request" pair each test sets just before calling `app.request`,
 * mirroring what the route's own `and(eq(id), eq(tenantId))` filters
 * for. Passing no rows simulates an outright miss. */
function fakeDbWithRows(
  rows: readonly {
    id: string;
    tenantId: string;
    assetId: string | null;
    name: string;
  }[],
): DB["db"] {
  return {
    query: {
      workflowDefinition: {
        findFirst: async () => {
          // `and(eq(id), eq(tenantId))` isn't inspectable here without a
          // real drizzle query builder; the route only ever calls this
          // with one id/tenant pair per request, so the test picks the
          // row up via the module-level "current request" the helper
          // below sets just before calling `app.request`.
          return currentLookup(rows);
        },
      },
    },
  } as unknown as DB["db"];
}

let lookupId: string | undefined;
let lookupTenant: string | undefined;

function currentLookup(
  rows: readonly {
    id: string;
    tenantId: string;
    assetId: string | null;
    name: string;
  }[],
) {
  return rows.find(
    (row) => row.id === lookupId && row.tenantId === lookupTenant,
  );
}

const authenticateAsTenant1: WorkflowRunAuthenticator = {
  resolve: (token, address) =>
    Promise.resolve(
      token === SIDECAR_TOKEN && address === RUN_ADDRESS
        ? ({
            tenantId: TENANT_ID,
            principalId: "prn_1",
            runId: "run_1",
          } satisfies WorkflowSkillPinRunScope)
        : null,
    ),
};

function buildApp(opts: {
  assetService?: AssetService;
  db?: DB["db"];
  authenticator?: WorkflowRunAuthenticator;
  skillsStore?: DefinitionSkillsStore;
}): Hono {
  return createWorkflowSkillPinRoutes({
    db: opts.db ?? fakeDbWithRows([]),
    assetService: opts.assetService ?? fakeAssetService(),
    skillIndex: fakeSkillIndex,
    skillsStore: opts.skillsStore ?? createInMemoryDefinitionSkillsStore(),
    authenticator: opts.authenticator ?? authenticateAsTenant1,
  }) as unknown as Hono;
}

async function postPin(
  app: Hono,
  body: unknown,
  headers: Record<string, string> = {
    authorization: `Bearer ${SIDECAR_TOKEN}`,
    "x-workflow-run-address": RUN_ADDRESS,
  },
): Promise<Response> {
  return app.request("/pin", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("a missing or unrecognized bearer token / run address is a 401", async () => {
  const app = buildApp({});
  const response = await postPin(
    app,
    { definitionId: TARGET_DEFINITION_ID, skillName: "research" },
    {},
  );
  expect(response.status).toBe(401);
});

test("an unknown definitionId is a 404", async () => {
  lookupId = TARGET_DEFINITION_ID;
  lookupTenant = TENANT_ID;
  const app = buildApp({
    db: fakeDbWithRows([]),
  });
  const response = await postPin(app, {
    definitionId: TARGET_DEFINITION_ID,
    skillName: "research",
  });
  expect(response.status).toBe(404);
});

test("a definition in a different tenant is a 404, never leaked across tenants", async () => {
  lookupId = TARGET_DEFINITION_ID;
  lookupTenant = TENANT_ID;
  const app = buildApp({
    db: fakeDbWithRows([
      {
        id: TARGET_DEFINITION_ID,
        tenantId: OTHER_TENANT_ID,
        assetId: "ast_1",
        name: "research-buddy",
      },
    ]),
  });
  const response = await postPin(app, {
    definitionId: TARGET_DEFINITION_ID,
    skillName: "research",
  });
  expect(response.status).toBe(404);
});

test("a workbench-host definition is a 404, never a pinnable target", async () => {
  lookupId = WORKBENCH_HOST_DEFINITION_ID;
  lookupTenant = TENANT_ID;
  const app = buildApp({
    db: fakeDbWithRows([
      {
        id: WORKBENCH_HOST_DEFINITION_ID,
        tenantId: TENANT_ID,
        assetId: "ast_host",
        name: "ins-0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      },
    ]),
  });
  const response = await postPin(app, {
    definitionId: WORKBENCH_HOST_DEFINITION_ID,
    skillName: "research",
  });
  expect(response.status).toBe(404);
});

test("pins a skill onto another definition in the same tenant and re-indexes its prompt", async () => {
  lookupId = TARGET_DEFINITION_ID;
  lookupTenant = TENANT_ID;
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  let writtenMessage: string | undefined;
  const skillsStore = createInMemoryDefinitionSkillsStore();
  const app = buildApp({
    db: fakeDbWithRows([
      {
        id: TARGET_DEFINITION_ID,
        tenantId: TENANT_ID,
        assetId: "ast_1",
        name: "research-buddy",
      },
    ]),
    assetService: fakeAssetService({
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        writtenMessage = params.tree.message;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    skillsStore,
  });
  const response = await postPin(app, {
    definitionId: TARGET_DEFINITION_ID,
    skillName: "research",
  });
  expect(response.status).toBe(200);
  expect(Object.keys(writtenFiles ?? {})).toEqual(["workflow.json"]);
  expect(writtenMessage).toBe("Pin research skill to research-buddy");
  expect(await skillsStore.getSkills("ast_1")).toEqual(["research"]);
  const body = (await response.json()) as { skills: string[] };
  expect(body.skills).toEqual(["research"]);
});

test("pinning the same skill twice is idempotent, never duplicated", async () => {
  lookupId = TARGET_DEFINITION_ID;
  lookupTenant = TENANT_ID;
  const skillsStore = createInMemoryDefinitionSkillsStore();
  await skillsStore.setSkills("ast_1", ["research"]);
  const app = buildApp({
    db: fakeDbWithRows([
      {
        id: TARGET_DEFINITION_ID,
        tenantId: TENANT_ID,
        assetId: "ast_1",
        name: "research-buddy",
      },
    ]),
    skillsStore,
  });
  const response = await postPin(app, {
    definitionId: TARGET_DEFINITION_ID,
    skillName: "research",
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { skills: string[] };
  expect(body.skills).toEqual(["research"]);
  expect(await skillsStore.getSkills("ast_1")).toEqual(["research"]);
});

test("a malformed body is a 400", async () => {
  const app = buildApp({});
  const response = await postPin(app, { definitionId: TARGET_DEFINITION_ID });
  expect(response.status).toBe(400);
});
