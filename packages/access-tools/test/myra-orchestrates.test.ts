// Myra orchestrates the bench, end to end (CL-7465): the exact tool
// bundles the reactor invokes — `@corbits/agent-directory-tools`'s
// `create_agent` and `@corbits/access-tools`'s `grant_access` — drive the
// REAL mounted hub routes (`createWorkflowAgentCreateRoutes` and
// `createWorkflowAccessRoutes`) through a stubbed `fetch` dispatcher, with
// a scripted turn list standing in for model inference. Turn 1 creates a
// specialist agent through the native workflow-run create route (same
// materialization the tenant-session route uses); turn 2 mints that
// specialist a scoped grant through the native grant route, which lands a
// real row in Postgres; turn 3 reads it back through `list_grants`.
//
// The deployer seam stays stubbed (a real deploy needs the sidecar probe),
// mirroring `packages/agent-directory/test/workflow-create-routes.test.ts`'s
// own fakes — the route, its auth, its inventory checks, and its core
// input are all real. The grant leg is fully real: route + in-memory
// `@intx/authz` store + drizzle Postgres handle.
//
// DB-gated like `./routes.test.ts`: needs `DATABASE_URL` (see
// `scripts/e2e/db-gate`).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ToolCall } from "@intx/types/runtime";

import { createDB, schema, type DB } from "@intx/db";
import { createInMemoryGrantStore } from "@intx/authz";
import { generateId } from "@intx/hub-common";
import {
  createWorkflowAgentCreateRoutes,
  type CapabilityInventoryProvider,
  type CreateWorkflowAgentCreateRoutesDeps,
  type WorkflowCapabilityRunScope,
  type WorkflowCapabilityRunAuthenticator,
} from "@corbits/agent-directory";
import {
  agentDirectoryTools,
  CREATE_AGENT_TOOL,
  type WorkflowAgentDirectoryEnv,
} from "@corbits/agent-directory-tools";
import { CORBITS_TOOLS_REGISTRY } from "@corbits/tool-registry-publish";
import { dbGate } from "../../../scripts/e2e/db-gate";

import {
  createWorkflowAccessRoutes,
  type WorkflowRunAuthenticator,
} from "../src/routes";
import {
  accessTools,
  GRANT_ACCESS_TOOL,
  LIST_GRANTS_TOOL,
  type WorkflowAccessEnv,
} from "../src/tool";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = dbGate(databaseUrl, import.meta.path);

function dbConfigFromUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port === "" ? 5432 : Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
  };
}

// Mirrors `./routes.test.ts`'s own helper: a system-origin store row for
// the caller, the same shape `createRequireGrant` and the ceiling check
// read in production.
function storeGrant(principalId: string, resource: string, action: string) {
  return {
    id: generateId("grant"),
    resource,
    action,
    effect: "allow" as const,
    origin: "system" as const,
    conditions: null,
    expiresAt: null,
    roleId: null,
    principalId,
  };
}

describeIfDb("Myra orchestrates the bench", () => {
  let db: DB;

  const tenantId = generateId("tenant");
  const callerPrincipalId = generateId("principal");
  const specialistPrincipalId = generateId("principal");
  const SIDECAR_TOKEN = "sidecar-token-for-this-run";
  const RUN_ADDRESS = "myra-run@tenant.example.test";
  const SPECIALIST_ADDRESS = "release-notes-writer@tenant.example.test";

  const HUB_ORIGIN = "https://hub.example.com";

  beforeAll(async () => {
    if (databaseUrl === undefined) return;
    db = createDB(dbConfigFromUrl(databaseUrl));

    await db.db.insert(schema.tenant).values({
      id: tenantId,
      name: "Myra Orchestrates Test Tenant",
      slug: `myra-orchestrates-${tenantId}`,
      domain: `myra-orchestrates-${tenantId}.localhost`,
      parentId: null,
      config: null,
    });
    await db.db.insert(schema.principal).values([
      {
        id: callerPrincipalId,
        tenantId,
        kind: "workflow",
        refId: RUN_ADDRESS,
        status: "active",
      },
      {
        id: specialistPrincipalId,
        tenantId,
        kind: "agent",
        refId: SPECIALIST_ADDRESS,
        status: "active",
      },
    ]);
  });

  afterAll(async () => {
    if (databaseUrl === undefined) return;
    await db.db.delete(schema.grant).where(eq(schema.grant.tenantId, tenantId));
    await db.db
      .delete(schema.principal)
      .where(eq(schema.principal.tenantId, tenantId));
    await db.db.delete(schema.tenant).where(eq(schema.tenant.id, tenantId));
  });

  // The agent-create fakes below mirror
  // `packages/agent-directory/test/workflow-create-routes.test.ts` — one
  // deliberate difference: `currentVersion` is the string `"1"`, matching
  // the real `workflow_definition.current_version` text column (CL-6480),
  // which the tool client parses as `"string"`.
  type FakeDefinitionRow = {
    id: string;
    tenantId: string;
    name: string;
    description: string | null;
    status: string;
    currentVersion: string;
    assetId: string | null;
  };

  const createdRow: FakeDefinitionRow = {
    id: "def_new",
    tenantId,
    name: "Release Notes Writer",
    description: null,
    status: "deployed",
    currentVersion: "1",
    assetId: "ast_new",
  };

  function fakeAgentDb(): DB["db"] {
    return {
      query: {
        tenant: {
          findFirst: async () => ({
            id: tenantId,
            domain: `myra-orchestrates-${tenantId}.localhost`,
            parentId: null,
          }),
        },
        asset: {
          findFirst: async () => ({
            id: "ast_corbits_tools",
            tenantId,
            kind: "package-registry" as const,
            name: CORBITS_TOOLS_REGISTRY,
          }),
        },
        workflowDefinition: {
          findFirst: async () => createdRow,
          findMany: async () => [createdRow],
        },
      },
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([
                {
                  tenantId,
                  creatorPrincipalId: null,
                  name: createdRow.name,
                  displayName: createdRow.name,
                },
              ]),
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

  function fakeAssetService(
    onPopulate?: (files: Record<string, string | Uint8Array>) => void,
  ): CreateWorkflowAgentCreateRoutesDeps["assetService"] {
    return {
      createAsset: () =>
        Promise.resolve({ id: "ast_new", tenantId, kind: "workflow" }),
      populateAsset: (params: {
        tree: { files: Record<string, string | Uint8Array> };
      }) => {
        onPopulate?.(params.tree.files);
        return Promise.resolve({ commitSha: "deadbeef" });
      },
      readAssetBlob: () => {
        throw new Error("not used in this test");
      },
      listAssetBlobs: () => Promise.resolve(["corbits-memory-tools-1.4.0.tgz"]),
    } as unknown as CreateWorkflowAgentCreateRoutesDeps["assetService"];
  }

  const fakeCapabilityInventory: CapabilityInventoryProvider = {
    resolve: () =>
      Promise.resolve({
        toolPackages: [{ name: "@corbits/memory-tools" }],
        skills: [{ name: "research" }],
        models: [{ canonicalName: "anthropic/claude-sonnet" }],
      }),
  };

  const fakeSkillIndex = {
    resolve: (
      _tenantId: string,
      _principalId: string,
      names: readonly string[],
    ) =>
      Promise.resolve(
        names.map((name) => ({ name, description: `What ${name} does.` })),
      ),
  };

  function recordingDeployer() {
    const deploys: {
      tenantId: string;
      principalId: string;
      assetId: string;
      assetName: string;
      commitSha: string;
      entry: string;
    }[] = [];
    return {
      deploys,
      deploy: (input: {
        tenantId: string;
        principalId: string;
        assetId: string;
        assetName: string;
        commitSha: string;
        entry: string;
      }) => {
        deploys.push(input);
        return Promise.resolve({
          deploymentId: "dep_1",
          definitionAssetId: input.assetId,
          status: "deployed" as const,
        });
      },
    };
  }

  const agentAuthenticator: WorkflowCapabilityRunAuthenticator = {
    resolve: (token, address) =>
      Promise.resolve(
        token === SIDECAR_TOKEN && address === RUN_ADDRESS
          ? ({
              tenantId,
              principalId: callerPrincipalId,
              runId: "run_myra",
            } satisfies WorkflowCapabilityRunScope)
          : null,
      ),
  };

  const accessAuthenticator: WorkflowRunAuthenticator = {
    async resolve(token, runAddress) {
      if (token !== SIDECAR_TOKEN || runAddress !== RUN_ADDRESS) return null;
      return { tenantId, principalId: callerPrincipalId };
    },
  };

  // Stands in for the hub origin: every bundle client builds absolute
  // URLs under the mount points above, so the full URL passes straight
  // through with method, auth headers, and body untouched — exactly what
  // the sidecar sends in production.
  function hubFetch(hub: Hono) {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (!url.startsWith(HUB_ORIGIN)) {
        throw new Error(`myra-orchestrates test: unexpected fetch to ${url}`);
      }
      return hub.request(url, init);
    }) as unknown as typeof fetch;
  }

  function callFor(name: string, args: Record<string, unknown>): ToolCall {
    return { id: `call_${name}`, name, arguments: args };
  }

  test("a Myra run creates a specialist agent, then grants it scoped access", async () => {
    const deployer = recordingDeployer();
    let populatedFiles: Record<string, string | Uint8Array> | undefined;
    const agentRoutesApp = createWorkflowAgentCreateRoutes({
      db: fakeAgentDb(),
      assetService: fakeAssetService((files) => {
        populatedFiles = files;
      }),
      skillIndex: fakeSkillIndex,
      capabilityInventory: fakeCapabilityInventory,
      authenticator: agentAuthenticator,
      deployer,
    });

    const accessRoutesApp = createWorkflowAccessRoutes({
      db: db.db,
      authenticator: accessAuthenticator,
      grantStore: createInMemoryGrantStore([
        storeGrant(callerPrincipalId, "grant:*", "create"),
        storeGrant(callerPrincipalId, "grant:*", "read"),
        storeGrant(callerPrincipalId, "room:*", "read"),
      ]),
      conditionRegistry: {},
    });

    const hub = new Hono();
    // Same mount points as the real composition root
    // (`apps/hub/src/index.ts`): the bundles' clients build these exact
    // absolute paths, so the stubbed fetch below hands the full URL
    // straight to this parent — no prefix surgery, no drift.
    hub.route("/api/workflow-agent-directory", agentRoutesApp);
    hub.route("/api/workflow-access", accessRoutesApp);

    const directoryEnv = {
      hubAgentDirectoryUrl: HUB_ORIGIN,
      hubChatUrl: `${HUB_ORIGIN}/api/workflow-chat`,
      sidecarToken: SIDECAR_TOKEN,
      address: RUN_ADDRESS,
    } as unknown as WorkflowAgentDirectoryEnv;
    const accessEnv = {
      hubAccessUrl: `${HUB_ORIGIN}/api/workflow-access`,
      sidecarToken: SIDECAR_TOKEN,
      address: RUN_ADDRESS,
    } as unknown as WorkflowAccessEnv;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = hubFetch(hub);
    try {
      const directoryBundle = agentDirectoryTools(directoryEnv);
      const accessBundle = accessTools(accessEnv);
      const signal = new AbortController().signal;

      // Turn 1 (stubbed inference): stand up the specialist. `invite:
      // false` keeps this leg on the definitions route — opening the
      // specialist's own chat is `@corbits/chat`'s participant surface,
      // covered by its own suites, not this flow.
      const created = await directoryBundle.run(
        callFor(CREATE_AGENT_TOOL, {
          name: "Release Notes Writer",
          systemPrompt: "You write crisp release notes from commit lists.",
          toolPackagePins: ["@corbits/memory-tools"],
          invite: false,
        }),
        signal,
      );
      expect(created.isError).toBe(false);
      expect(created.content).toContain("Release Notes Writer");
      expect(created.content).toContain("def_new");

      // The native core path ran: the definition's source tree was
      // materialized and the tenant-scoped deploy recorded.
      expect(populatedFiles).toBeDefined();
      expect(deployer.deploys).toHaveLength(1);
      expect(deployer.deploys[0]?.tenantId).toBe(tenantId);
      expect(deployer.deploys[0]?.assetName).toBe("release-notes-writer");
      expect(deployer.deploys[0]?.commitSha).toBe("deadbeef");

      // Turn 2 (stubbed inference): give the specialist room:read,
      // inside Myra's own ceiling — the route persists a native row.
      const granted = await accessBundle.run(
        callFor(GRANT_ACCESS_TOOL, {
          principalId: specialistPrincipalId,
          resource: "room:*",
          actions: ["read"],
        }),
        signal,
      );
      expect(granted.isError).toBe(false);
      expect(granted.content).toContain("1 grant created");

      // Turn 3 (stubbed inference): read it back through the native
      // list surface — proof the grant survived the round trip.
      const listed = await accessBundle.run(
        callFor(LIST_GRANTS_TOOL, { principalId: specialistPrincipalId }),
        signal,
      );
      expect(listed.isError).toBe(false);
      expect(listed.content).toContain(
        `allow room:*:read -> principal ${specialistPrincipalId}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    // And the row is really in Postgres, not just in the route's
    // response envelope.
    const rows = await db.db.query.grant.findMany({
      where: eq(schema.grant.tenantId, tenantId),
    });
    expect(
      rows.some(
        (row) =>
          row.principalId === specialistPrincipalId &&
          row.resource === "room:*" &&
          row.action === "read" &&
          row.effect === "allow",
      ),
    ).toBe(true);
  });
});
