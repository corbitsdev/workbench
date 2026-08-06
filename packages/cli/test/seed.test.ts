import { describe, expect, test } from "bun:test";
import type { SeedConfig } from "../src/config";
import { CliError } from "../src/errors";
import {
  DEFAULT_WORKFLOWS,
  runSeed,
  type SeedDeps,
  type WorkflowPusher,
} from "../src/seed";
import {
  assetRow,
  collector,
  deploymentRow,
  emptyPage,
  fakeAPI,
  principalsResponse,
  signUpResponse,
  tenantRow,
  TENANT_DOMAIN,
  TENANT_ID,
  type FakeHandler,
} from "./helpers";

const CONFIG: SeedConfig = {
  hubUrl: "http://localhost:3000",
  adminEmail: "admin@example.com",
  adminPassword: "password123",
  orgSlug: "workbench",
  modelSource: {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    baseURL: "https://api.anthropic.com/v1",
    apiKey: "sk-test",
  },
};

const instantSleep = async (_ms: number) => {};

const recordingPusher = () => {
  const pushes: { remoteUrl: string; workflowJson: string }[] = [];
  const push: WorkflowPusher = async (args) => {
    pushes.push({ remoteUrl: args.remoteUrl, workflowJson: args.workflowJson });
    return "pushed";
  };
  return { pushes, push };
};

function deps(overrides: Partial<SeedDeps> & Pick<SeedDeps, "api">): SeedDeps {
  const { log } = collector();
  return {
    config: CONFIG,
    pushWorkflow: recordingPusher().push,
    log,
    sleep: instantSleep,
    runStartTimeoutMs: 3,
    runPollIntervalMs: 1,
    ...overrides,
  };
}

// Shared routes for the calls every seed run makes before touching
// workflow state: authentication, tenant resolution, and grants.
function baseRoutes(method: string, path: string) {
  if (method === "POST" && path === "/api/auth/sign-up/email")
    return signUpResponse();
  if (method === "GET" && path === "/api/me/principals")
    return principalsResponse();
  if (method === "GET" && path === `/api/tenants/${TENANT_ID}`)
    return { status: 200, data: tenantRow() };
  if (method === "GET" && path.startsWith(`/api/tenants/${TENANT_ID}/grants?`))
    return emptyPage();
  if (method === "POST" && path === `/api/tenants/${TENANT_ID}/grants`)
    return { status: 201, data: {} };
  if (method === "POST" && path === `/api/tenants/${TENANT_ID}/git-tokens`)
    return { status: 201, data: { id: "tok_1", secret: "s3cret" } };
  return undefined;
}

describe("runSeed", () => {
  test("fresh run pushes, deploys, and confirms the echo workflow", async () => {
    const { lines, log } = collector();
    const { pushes, push } = recordingPusher();
    let runsCalls = 0;
    const handler: FakeHandler = (method, path, _body) => {
      const base = baseRoutes(method, path);
      if (base) return base;
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`)
        return { status: 201, data: assetRow("ast_1", "echo") };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/instances`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/instances`
      )
        return { status: 201, data: deploymentRow("dep_1", "ast_1", "active") };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_1/runs`
      ) {
        runsCalls += 1;
        return {
          status: 200,
          data: { runIds: runsCalls === 1 ? [] : ["run_1"] },
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_1/mail`
      )
        return {
          status: 202,
          data: {
            deploymentId: "dep_1",
            address: `ins_dep_1@${TENANT_DOMAIN}`,
            messageId: "<m1@workbench.localhost>",
          },
        };
      return undefined;
    };

    await runSeed(deps({ api: fakeAPI(handler), pushWorkflow: push, log }));

    expect(pushes).toHaveLength(1);
    const push0 = pushes[0];
    if (!push0) throw new Error("expected one workflow push");
    expect(push0.remoteUrl).toBe(
      `http://localhost:3000/api/tenants/${TENANT_ID}/assets/workflow/echo.git`,
    );
    const definition = JSON.parse(push0.workflowJson) as {
      id: string;
      triggers: { type: string; to: string }[];
      stepOrder: string[];
    };
    expect(definition.id).toBe("wf_echo");
    expect(definition.triggers[0]?.to).toBe(`echo@${TENANT_DOMAIN}`);
    expect(definition.stepOrder).toEqual(["echo"]);

    const output = lines.join("\n");
    expect(output).toContain("created workflow asset echo");
    expect(output).toContain("deployed workflow echo as dep_1");
    expect(output).toContain("confirmed workflow echo: run run_1 started");
    expect(output).toContain("seed complete: 1 workflow(s)");
  });

  test("re-run skips the asset, definition, and deployment but still confirms", async () => {
    const { lines, log } = collector();
    const push: WorkflowPusher = async () => "unchanged";
    let runsCalls = 0;
    const handler: FakeHandler = (method, path) => {
      const base = baseRoutes(method, path);
      if (base) return base;
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`)
        return { status: 409, data: { error: "name taken" } };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/assets?kind=workflow`
      )
        return {
          status: 200,
          data: [
            {
              ...assetRow("ast_1", "echo"),
              origin: { tenantId: TENANT_ID, direct: true },
            },
          ],
        };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/instances`
      )
        return {
          status: 200,
          data: [deploymentRow("dep_1", "ast_1", "active")],
        };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_1/runs`
      ) {
        runsCalls += 1;
        return {
          status: 200,
          data: { runIds: runsCalls === 1 ? ["run_1"] : ["run_1", "run_2"] },
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_1/mail`
      )
        return {
          status: 202,
          data: {
            deploymentId: "dep_1",
            address: `ins_dep_1@${TENANT_DOMAIN}`,
            messageId: "<m2@workbench.localhost>",
          },
        };
      return undefined;
    };

    await runSeed(deps({ api: fakeAPI(handler), pushWorkflow: push, log }));

    const output = lines.join("\n");
    expect(output).toContain("workflow asset echo already exists (skipped)");
    expect(output).toContain(
      "workflow.json for echo already current (skipped)",
    );
    expect(output).toContain(
      "workflow echo already deployed as dep_1 (skipped)",
    );
    expect(output).toContain("confirmed workflow echo: run run_2 started");
  });

  test("an unreachable deployment address names the sidecar as the fix", async () => {
    const handler: FakeHandler = (method, path) => {
      const base = baseRoutes(method, path);
      if (base) return base;
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`)
        return { status: 201, data: assetRow("ast_1", "echo") };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/instances`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/instances`
      )
        return { status: 201, data: deploymentRow("dep_1", "ast_1", "active") };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_1/runs`
      )
        return { status: 200, data: { runIds: [] } };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_1/mail`
      )
        return {
          status: 409,
          data: { error: { code: "deployment_unreachable" } },
        };
      return undefined;
    };

    let caught: unknown;
    try {
      await runSeed(deps({ api: fakeAPI(handler) }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).message).toContain("not routable");
    expect((caught as CliError).fix).toContain("sidecar");
  });

  test("a deploy that succeeds but never starts a run is a failure, not a success", async () => {
    const handler: FakeHandler = (method, path) => {
      const base = baseRoutes(method, path);
      if (base) return base;
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`)
        return { status: 201, data: assetRow("ast_1", "echo") };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/instances`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/instances`
      )
        return { status: 201, data: deploymentRow("dep_1", "ast_1", "active") };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_1/runs`
      )
        return { status: 200, data: { runIds: [] } };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_1/mail`
      )
        return {
          status: 202,
          data: {
            deploymentId: "dep_1",
            address: `ins_dep_1@${TENANT_DOMAIN}`,
            messageId: "<m3@workbench.localhost>",
          },
        };
      return undefined;
    };

    expect(runSeed(deps({ api: fakeAPI(handler) }))).rejects.toThrow(
      /no run started/,
    );
  });

  test("a sidecar-unavailable deploy fails with the start-the-stack fix", async () => {
    const handler: FakeHandler = (method, path) => {
      const base = baseRoutes(method, path);
      if (base) return base;
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`)
        return { status: 201, data: assetRow("ast_1", "echo") };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/instances`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/instances`
      )
        return {
          status: 502,
          data: { error: { code: "sidecar_unavailable" } },
        };
      return undefined;
    };

    let caught: unknown;
    try {
      await runSeed(deps({ api: fakeAPI(handler) }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).fix).toContain("bun run dev");
  });

  test("a missing bench points at workbench setup", async () => {
    const handler: FakeHandler = (method, path) => {
      if (method === "POST" && path === "/api/auth/sign-up/email")
        return signUpResponse();
      if (method === "GET" && path === "/api/me/principals")
        return { status: 200, data: { data: [], nextCursor: null } };
      return undefined;
    };

    let caught: unknown;
    try {
      await runSeed(deps({ api: fakeAPI(handler) }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).fix).toContain("workbench setup");
  });

  test("an empty default workflow set is an error", async () => {
    const api = fakeAPI(() => {
      throw new Error("no hub call should happen for an empty set");
    });
    expect(runSeed(deps({ api }), [])).rejects.toThrow(/zero workflows/);
  });

  test("the default set is non-empty and starts with the echo workflow", () => {
    expect(DEFAULT_WORKFLOWS.length).toBeGreaterThan(0);
    expect(DEFAULT_WORKFLOWS[0]?.assetName).toBe("echo");
  });
});
