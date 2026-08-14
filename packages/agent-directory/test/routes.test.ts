// Route-level tests cover this package's own wiring: request parsing,
// grant gating, and error-envelope mapping. The definition-projection
// path (`ensureWorkflowDefinitionForAsset` + the read-back query) is
// `@intx/hub-sessions`/`@intx/db` machinery already covered upstream —
// re-proving it here against a hand-rolled fake drizzle db would be
// coverage theater, not a meaningful test of this package's code.

import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { TenantEnv } from "@intx/hub-api";
import { AssetServiceError } from "@intx/hub-sessions";
import type { AssetService } from "@intx/hub-sessions";
import type { DB } from "@intx/db";

import {
  buildAgentDefinitionWorkflow,
  serializeAgentDefinitionWorkflow,
} from "../src/agent-workflow";
import { createAgentDefinitionRoutes } from "../src/routes";
import type { PinnedSkillIndexResolver } from "../src/routes";

/** Resolves every pinned name to a one-line description, so a route test
 * can assert on the stanza without standing up the registry. */
const fakeSkillIndex: PinnedSkillIndexResolver = {
  resolve: (_tenantId, _principalId, names) =>
    Promise.resolve(
      names.map((name) => ({ name, description: `What ${name} does.` })),
    ),
};

const TENANT = {
  id: "tnt_1",
  name: "Acme",
  slug: "acme",
  domain: "acme.example",
  parentId: null,
  config: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const PRINCIPAL = {
  id: "prn_1",
  tenantId: TENANT.id,
  kind: "user" as const,
  refId: "prn_1",
  status: "active" as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};

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

/** The serialized definition a stored `workflow.json` carries, so the
 * PUT path has something real to re-index. */
function storedDefinitionBytes(
  systemPrompt = "You are a careful research assistant.",
): Uint8Array {
  return new TextEncoder().encode(
    serializeAgentDefinitionWorkflow(
      buildAgentDefinitionWorkflow({
        handle: "research-buddy",
        tenantDomain: TENANT.domain,
        description: "",
        systemPrompt,
      }),
    ),
  );
}

/** The one step agent's system prompt inside a serialized definition. */
function promptFrom(workflowJson: string): string {
  const parsed = JSON.parse(workflowJson) as {
    steps: Record<string, { agent: { systemPrompt: string } }>;
  };
  const step = Object.values(parsed.steps)[0];
  if (step === undefined) throw new Error("definition carries no steps");
  return step.agent.systemPrompt;
}

// The duplicate-asset recovery path queries `db` directly (looking up the
// existing asset and its definition) before deciding whether to reuse an
// empty shell or surface a real 409. When the shell is reused the route
// continues through populateAsset → ensureWorkflowDefinitionForAsset →
// read-back, so the fake also provides just enough of drizzle's chainable
// query-builder API (`.select().from().where().limit()`,
// `.insert().values().onConflictDoNothing().returning()`) for that
// projection — the projection logic itself is `@intx/hub-sessions`/
// `@intx/db` machinery already covered upstream; the fake only needs to
// return plausible rows, not re-prove the SQL.

type FakeDbOptions = {
  existingAsset?: { id: string };
  hasDefinition?: boolean;
};

function fakeDb(opts: FakeDbOptions = {}): DB["db"] {
  let wfDefFindFirstCalls = 0;

  const selectResult = [
    {
      tenantId: TENANT.id,
      creatorPrincipalId: null,
      name: "research-buddy",
      displayName: "Research Buddy",
    },
  ];

  return {
    query: {
      asset: {
        findFirst: async () => opts.existingAsset ?? undefined,
      },
      workflowDefinition: {
        findFirst: async () => {
          wfDefFindFirstCalls += 1;
          if (wfDefFindFirstCalls === 1) {
            return opts.hasDefinition ? { id: "def_existing" } : undefined;
          }
          // Read-back after ensureWorkflowDefinitionForAsset.
          return {
            id: "def_new",
            tenantId: TENANT.id,
            name: "Research Buddy",
            description: null,
            currentVersion: "1",
            status: "deployed",
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
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
          returning: () => Promise.resolve([{ id: "def_new" }]),
          then: (onFulfilled: unknown) =>
            Promise.resolve([]).then(onFulfilled as never),
        };
        return chain;
      },
    }),
  } as unknown as DB["db"];
}

function buildApp(
  assetService: AssetService,
  db: DB["db"] = fakeDb(),
): Hono<TenantEnv> {
  const routes = createAgentDefinitionRoutes({
    db,
    assetService,
    skillIndex: fakeSkillIndex,
    requireGrant: () => async (_c, next) => {
      await next();
    },
  });
  const asPrincipal: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT);
    c.set("principal", PRINCIPAL);
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asPrincipal);
  app.route("/", routes);
  return app;
}

async function post(app: Hono<TenantEnv>, body: unknown): Promise<Response> {
  return app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function put(
  app: Hono<TenantEnv>,
  path: string,
  body: unknown,
): Promise<Response> {
  return app.request(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a malformed body is rejected with a field-scoped 400", async () => {
  const app = buildApp(fakeAssetService());
  const response = await post(app, {
    name: "",
    handle: "Not Kebab",
    systemPrompt: "hello",
  });
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: { message: string } };
  expect(body.error.message).toContain("invalid agent definition");
});

test("a missing system prompt is rejected before any asset is created", async () => {
  let createCalled = false;
  const app = buildApp(
    fakeAssetService({
      createAsset: () => {
        createCalled = true;
        throw new Error("should never be called");
      },
    }),
  );
  const response = await post(app, {
    name: "Research Buddy",
    handle: "research-buddy",
  });
  expect(response.status).toBe(400);
  expect(createCalled).toBe(false);
});

test("a duplicate handle surfaces as a 409, not a 500", async () => {
  const app = buildApp(
    fakeAssetService({
      createAsset: () => {
        throw new AssetServiceError(
          "duplicate_asset",
          'an asset named "research-buddy" already exists',
        );
      },
    }),
  );
  const response = await post(app, {
    name: "Research Buddy",
    handle: "research-buddy",
    systemPrompt: "You are a careful research assistant.",
  });
  expect(response.status).toBe(409);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe("conflict");
});

test("an unrelated asset-service failure is not swallowed as a conflict", async () => {
  const app = buildApp(
    fakeAssetService({
      createAsset: () => {
        throw new Error("the git backend is unreachable");
      },
    }),
  );
  const response = await post(app, {
    name: "Research Buddy",
    handle: "research-buddy",
    systemPrompt: "You are a careful research assistant.",
  });
  // Hono's default error handler turns an uncaught throw into a 500
  // rather than the 409 the duplicate-asset path returns — proving this
  // route re-throws instead of misclassifying every asset-service
  // failure as a handle conflict.
  expect(response.status).toBe(500);
});

// A minimal db fake for the straight-through create path (no duplicate-asset
// recovery in play): `query.workflowDefinition.findFirst` is called exactly
// once, for the final read-back, so it can answer unconditionally — unlike
// `fakeDb()` above, whose call-count switch exists only to serve the
// duplicate-recovery tests, none of which reach this point.
function fakeCreateDb(): DB["db"] {
  return {
    query: {
      workflowDefinition: {
        findFirst: async () => ({
          id: "def_new",
          tenantId: TENANT.id,
          name: "Research Buddy",
          description: null,
          currentVersion: "1",
          status: "deployed",
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([
              {
                tenantId: TENANT.id,
                creatorPrincipalId: null,
                name: "research-buddy",
                displayName: "Research Buddy",
              },
            ]),
        }),
      }),
    }),
    insert: () => ({
      values: () => {
        const chain: Record<string, unknown> = {
          onConflictDoNothing: () => chain,
          returning: () => Promise.resolve([{ id: "def_new" }]),
          then: (onFulfilled: unknown) =>
            Promise.resolve([]).then(onFulfilled as never),
        };
        return chain;
      },
    }),
  } as unknown as DB["db"];
}

test("a create request with skills writes skills.json alongside workflow.json in one commit", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const app = buildApp(
    fakeAssetService({
      createAsset: () =>
        Promise.resolve({
          id: "ast_1",
          tenantId: TENANT.id,
          kind: "workflow" as const,
          name: "research-buddy",
          displayName: "Research Buddy",
          creatorPrincipalId: PRINCIPAL.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    fakeCreateDb(),
  );
  const response = await post(app, {
    name: "Research Buddy",
    handle: "research-buddy",
    systemPrompt: "You are a careful research assistant.",
    skills: ["web-research", "long-form-write"],
  });
  expect(response.status).toBe(201);
  expect(writtenFiles).toBeDefined();
  expect(writtenFiles?.["workflow.json"]).toBeDefined();
  expect(JSON.parse(writtenFiles?.["skills.json"] as string)).toEqual({
    skills: ["web-research", "long-form-write"],
  });
  const body = (await response.json()) as { skills: readonly string[] };
  expect(body.skills).toEqual(["web-research", "long-form-write"]);
});

test("a create request without skills writes an empty skills.json", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const app = buildApp(
    fakeAssetService({
      createAsset: () =>
        Promise.resolve({
          id: "ast_1",
          tenantId: TENANT.id,
          kind: "workflow" as const,
          name: "research-buddy",
          displayName: "Research Buddy",
          creatorPrincipalId: PRINCIPAL.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    fakeCreateDb(),
  );
  const response = await post(app, {
    name: "Research Buddy",
    handle: "research-buddy",
    systemPrompt: "You are a careful research assistant.",
  });
  expect(response.status).toBe(201);
  expect(JSON.parse(writtenFiles?.["skills.json"] as string)).toEqual({
    skills: [],
  });
});

function fakeSkillsDb(
  row: { id: string; assetId: string | null } | undefined,
): DB["db"] {
  return {
    query: {
      workflowDefinition: {
        findFirst: async () =>
          row === undefined
            ? undefined
            : {
                id: row.id,
                tenantId: TENANT.id,
                assetId: row.assetId,
                name: "Research Buddy",
              },
      },
    },
  } as unknown as DB["db"];
}

test("GET /skills returns an empty list for a definition with no skills.json", async () => {
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: () =>
        Promise.reject(new AssetServiceError("not_found", "no skills.json")),
    }),
    fakeSkillsDb({ id: "def_1", assetId: "ast_1" }),
  );
  const response = await app.request("/skills?ids=def_1");
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    skills: Record<string, readonly string[]>;
  };
  expect(body.skills).toEqual({ def_1: [] });
});

test("GET /skills returns the parsed skill list when skills.json exists", async () => {
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: () =>
        Promise.resolve(
          new TextEncoder().encode(
            JSON.stringify({ skills: ["web-research"] }),
          ),
        ),
    }),
    fakeSkillsDb({ id: "def_1", assetId: "ast_1" }),
  );
  const response = await app.request("/skills?ids=def_1");
  const body = (await response.json()) as {
    skills: Record<string, readonly string[]>;
  };
  expect(body.skills).toEqual({ def_1: ["web-research"] });
});

test("GET /skills omits unknown definition ids from the map rather than erroring", async () => {
  const app = buildApp(fakeAssetService(), fakeSkillsDb(undefined));
  const response = await app.request("/skills?ids=def_missing");
  const body = (await response.json()) as {
    skills: Record<string, readonly string[]>;
  };
  expect(body.skills).toEqual({});
});

test("PUT /:definitionId/skills replaces the skill set with a single skills.json commit", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: () => Promise.resolve(storedDefinitionBytes()),
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    fakeSkillsDb({ id: "def_1", assetId: "ast_1" }),
  );
  const response = await put(app, "/def_1/skills", {
    skills: ["long-form-write"],
  });
  expect(response.status).toBe(200);
  expect(Object.keys(writtenFiles ?? {}).sort()).toEqual([
    "skills.json",
    "workflow.json",
  ]);
  expect(JSON.parse(writtenFiles?.["skills.json"] as string)).toEqual({
    skills: ["long-form-write"],
  });
  const body = (await response.json()) as { skills: readonly string[] };
  expect(body.skills).toEqual(["long-form-write"]);
});

test("PUT /:definitionId/skills 404s for an unknown definition", async () => {
  const app = buildApp(fakeAssetService(), fakeSkillsDb(undefined));
  const response = await put(app, "/def_missing/skills", { skills: [] });
  expect(response.status).toBe(404);
});

test("PUT /:definitionId/skills re-indexes the system prompt to exactly the new pins", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: () =>
        Promise.resolve(
          storedDefinitionBytes(
            "You are a careful research assistant.\n\n" +
              "<available_skills>\n- stale: gone now.\n</available_skills>",
          ),
        ),
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    fakeSkillsDb({ id: "def_1", assetId: "ast_1" }),
  );
  await put(app, "/def_1/skills", { skills: ["long-form-write"] });
  const prompt = promptFrom(writtenFiles?.["workflow.json"] as string);
  expect(prompt).toContain("- long-form-write: What long-form-write does.");
  expect(prompt).not.toContain("stale");
  expect(prompt.split("<available_skills>")).toHaveLength(2);
});

test("PUT /:definitionId/skills with no pins strips the index from the prompt", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: () =>
        Promise.resolve(
          storedDefinitionBytes(
            "You are a careful research assistant.\n\n" +
              "<available_skills>\n- stale: gone now.\n</available_skills>",
          ),
        ),
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    fakeSkillsDb({ id: "def_1", assetId: "ast_1" }),
  );
  await put(app, "/def_1/skills", { skills: [] });
  expect(promptFrom(writtenFiles?.["workflow.json"] as string)).toBe(
    "You are a careful research assistant.",
  );
});

test("PUT /:definitionId/skills rejects a duplicate skill name with a 400", async () => {
  const app = buildApp(
    fakeAssetService(),
    fakeSkillsDb({ id: "def_1", assetId: "ast_1" }),
  );
  const response = await put(app, "/def_1/skills", {
    skills: ["Web research", "Web research"],
  });
  expect(response.status).toBe(400);
});

test("PUT /:definitionId/skills rejects a blank skill name with a 400", async () => {
  const app = buildApp(
    fakeAssetService(),
    fakeSkillsDb({ id: "def_1", assetId: "ast_1" }),
  );
  const response = await put(app, "/def_1/skills", { skills: ["   "] });
  expect(response.status).toBe(400);
});

test("a create request indexes its pinned skills into the stored system prompt", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const app = buildApp(
    fakeAssetService({
      createAsset: () =>
        Promise.resolve({
          id: "ast_1",
          tenantId: TENANT.id,
          kind: "workflow" as const,
          name: "research-buddy",
          displayName: "Research Buddy",
          creatorPrincipalId: PRINCIPAL.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    fakeCreateDb(),
  );
  await post(app, {
    name: "Research Buddy",
    handle: "research-buddy",
    systemPrompt: "You are a careful research assistant.",
    skills: ["web-research"],
  });
  const prompt = promptFrom(writtenFiles?.["workflow.json"] as string);
  expect(prompt.startsWith("You are a careful research assistant.")).toBe(true);
  expect(prompt).toContain("- web-research: What web-research does.");
  expect(prompt).toContain("load_skill");
});

test("a create request with no pinned skills stores the author's prompt verbatim", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const app = buildApp(
    fakeAssetService({
      createAsset: () =>
        Promise.resolve({
          id: "ast_1",
          tenantId: TENANT.id,
          kind: "workflow" as const,
          name: "research-buddy",
          displayName: "Research Buddy",
          creatorPrincipalId: PRINCIPAL.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    fakeCreateDb(),
  );
  await post(app, {
    name: "Research Buddy",
    handle: "research-buddy",
    systemPrompt: "You are a careful research assistant.",
  });
  expect(promptFrom(writtenFiles?.["workflow.json"] as string)).toBe(
    "You are a careful research assistant.",
  );
});
