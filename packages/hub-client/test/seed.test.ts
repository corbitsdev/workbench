import { describe, expect, test } from "bun:test";
import { CliError } from "../src/errors";
import {
  CATALOG_TEST_WORKFLOWS,
  DEFAULT_WORKFLOWS,
  NOOP_MODEL_SOURCE,
  seedCatalog,
  seedTenant,
  type SeedTenantArgs,
  type WorkflowPusher,
} from "../src/seed";
import {
  assetRow,
  collector,
  deploymentRow,
  emptyPage,
  fakeAPI,
  TENANT_DOMAIN,
  TENANT_ID,
  PRINCIPAL_ID,
  type FakeHandler,
} from "./helpers";

const MODEL = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  baseURL: "https://api.anthropic.com",
  apiKey: "sk-test",
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

function args(
  overrides: Partial<SeedTenantArgs> & Pick<SeedTenantArgs, "api">,
): SeedTenantArgs {
  const { log } = collector();
  return {
    cookies: ["session=abc"],
    hubUrl: "http://localhost:3000",
    tenant: {
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      domain: TENANT_DOMAIN,
    },
    model: MODEL,
    pushWorkflow: recordingPusher().push,
    log,
    sleep: instantSleep,
    runStartTimeoutMs: 3,
    runPollIntervalMs: 1,
    ...overrides,
  };
}

// Shared routes every seed run makes before touching workflow state:
// planting the seed grants.
function baseRoutes(method: string, path: string) {
  if (method === "GET" && path.startsWith(`/api/tenants/${TENANT_ID}/grants?`))
    return emptyPage();
  if (method === "POST" && path === `/api/tenants/${TENANT_ID}/grants`)
    return { status: 201, data: {} };
  if (method === "POST" && path === `/api/tenants/${TENANT_ID}/git-tokens`)
    return { status: 201, data: { id: "tok_1", secret: "s3cret" } };
  return undefined;
}

describe("seedTenant", () => {
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
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return {
          status: 201,
          data: deploymentRow("dep_1", "ast_1", "deployed"),
        };
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

    const echoOnly = DEFAULT_WORKFLOWS.filter((w) => w.assetName === "echo");
    await seedTenant(
      args({
        api: fakeAPI(handler),
        pushWorkflow: push,
        log,
        workflows: echoOnly,
      }),
    );

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

  test("fresh run pushes, deploys, and confirms the assistant workflow", async () => {
    const { lines, log } = collector();
    const { pushes, push } = recordingPusher();
    let runsCalls = 0;
    const handler: FakeHandler = (method, path, _body) => {
      const base = baseRoutes(method, path);
      if (base) return base;
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`)
        return { status: 201, data: assetRow("ast_2", "assistant") };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return {
          status: 201,
          data: deploymentRow("dep_2", "ast_2", "deployed"),
        };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_2/runs`
      ) {
        runsCalls += 1;
        return {
          status: 200,
          data: { runIds: runsCalls === 1 ? [] : ["run_1"] },
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_2/mail`
      )
        return {
          status: 202,
          data: {
            deploymentId: "dep_2",
            address: `ins_dep_2@${TENANT_DOMAIN}`,
            messageId: "<m4@workbench.localhost>",
          },
        };
      return undefined;
    };

    const assistantOnly = DEFAULT_WORKFLOWS.filter(
      (w) => w.assetName === "assistant",
    );
    await seedTenant(
      args({
        api: fakeAPI(handler),
        pushWorkflow: push,
        log,
        workflows: assistantOnly,
      }),
    );

    expect(pushes).toHaveLength(1);
    const push0 = pushes[0];
    if (!push0) throw new Error("expected one workflow push");
    expect(push0.remoteUrl).toBe(
      `http://localhost:3000/api/tenants/${TENANT_ID}/assets/workflow/assistant.git`,
    );
    const definition = JSON.parse(push0.workflowJson) as {
      id: string;
      triggers: { type: string; to: string }[];
      stepOrder: string[];
    };
    expect(definition.id).toBe("wf_assistant");
    expect(definition.triggers[0]?.to).toBe(`assistant@${TENANT_DOMAIN}`);
    expect(definition.stepOrder).toEqual(["assistant"]);

    const output = lines.join("\n");
    expect(output).toContain("created workflow asset assistant (Myra)");
    expect(output).toContain("deployed workflow assistant as dep_2");
    expect(output).toContain("confirmed workflow assistant: run run_1 started");
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
        path ===
          `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
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
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return {
          status: 200,
          data: [deploymentRow("dep_1", "ast_1", "deployed")],
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

    const echoOnly = DEFAULT_WORKFLOWS.filter((w) => w.assetName === "echo");
    await seedTenant(
      args({
        api: fakeAPI(handler),
        pushWorkflow: push,
        log,
        workflows: echoOnly,
      }),
    );

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
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return {
          status: 201,
          data: deploymentRow("dep_1", "ast_1", "deployed"),
        };
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
      await seedTenant(args({ api: fakeAPI(handler) }));
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
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return {
          status: 201,
          data: deploymentRow("dep_1", "ast_1", "deployed"),
        };
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

    expect(seedTenant(args({ api: fakeAPI(handler) }))).rejects.toThrow(
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
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return {
          status: 502,
          data: { error: { code: "sidecar_unavailable" } },
        };
      return undefined;
    };

    let caught: unknown;
    try {
      await seedTenant(args({ api: fakeAPI(handler) }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).fix).toContain("bun run dev");
  });

  test("an empty default workflow set is an error", async () => {
    const api = fakeAPI(() => {
      throw new Error("no hub call should happen for an empty set");
    });
    expect(seedTenant(args({ api, workflows: [] }))).rejects.toThrow(
      /zero workflows/,
    );
  });

  test("the default set is non-empty and starts with the echo workflow", () => {
    expect(DEFAULT_WORKFLOWS.length).toBeGreaterThan(0);
    expect(DEFAULT_WORKFLOWS[0]?.assetName).toBe("echo");
  });

  test("the default set also includes the assistant workflow", () => {
    expect(DEFAULT_WORKFLOWS.map((w) => w.assetName)).toContain("assistant");
  });

  test("the seeded assistant is productized under the Myra display name", () => {
    // Every personal bench provisioning deploys DEFAULT_WORKFLOWS, which
    // includes the assistant. Its display name is the productized label
    // Myra — seed stamps it onto the asset at create time, so the seeded
    // assistant surfaces as Myra rather than the generic "Assistant".
    const assistant = DEFAULT_WORKFLOWS.find(
      (w) => w.assetName === "assistant",
    );
    expect(assistant).toBeDefined();
    expect(assistant?.displayName).toBe("Myra");
  });

  test("NOOP_MODEL_SOURCE resolves to the hub's own noop-inference endpoint", () => {
    const resolved = NOOP_MODEL_SOURCE("http://localhost:3000");
    expect(resolved.baseURL).toBe(
      "http://localhost:3000/api/chat/noop-inference",
    );
    expect(resolved.model).toBe("noop");
  });

  test("echo and assistant carry no modelSource override, so they deploy against the tenant's real model", () => {
    const realModelWorkflows = DEFAULT_WORKFLOWS.filter(
      (w) => w.assetName === "echo" || w.assetName === "assistant",
    );
    expect(realModelWorkflows).toHaveLength(2);
    for (const workflow of realModelWorkflows) {
      expect(workflow.modelSource).toBeUndefined();
    }
  });

  test("the default set consumed by real tenant provisioning is echo, assistant, and channel-digest", () => {
    // provisionPersonalTenantIfNeeded (@workbench/onboarding) deploys
    // DEFAULT_WORKFLOWS for every real signup. channel-digest is the
    // seed automation the Routines picker can honestly offer. The
    // remaining catalog-test workflows exist only to exercise the
    // platform continuously and must never reach a real user through
    // this array — they are seeded only via the explicit
    // CATALOG_TEST_WORKFLOWS opt-in.
    expect(DEFAULT_WORKFLOWS.map((w) => w.assetName)).toEqual([
      "echo",
      "assistant",
      "channel-digest",
    ]);
  });

  test("catalog-test workflows declare a modelSource override; defaults do not", () => {
    // Defaults (echo, assistant, channel-digest) deploy against the
    // tenant's real model. Catalog-test entries stay free via
    // NOOP_MODEL_SOURCE.
    for (const workflow of DEFAULT_WORKFLOWS) {
      expect(workflow.modelSource).toBeUndefined();
    }
    for (const workflow of CATALOG_TEST_WORKFLOWS) {
      expect(workflow.modelSource).toBeDefined();
    }
  });

  test("the catalog-test set includes the heartbeat workflow", () => {
    expect(CATALOG_TEST_WORKFLOWS.map((w) => w.assetName)).toContain(
      "heartbeat",
    );
  });

  test("heartbeat pins its deploy source at noop-inference, never the tenant's real model", () => {
    const heartbeat = CATALOG_TEST_WORKFLOWS.find(
      (w) => w.assetName === "heartbeat",
    );
    if (!heartbeat) throw new Error("expected the heartbeat workflow");
    const resolved = heartbeat.modelSource?.("http://localhost:3000");
    expect(resolved).toEqual(NOOP_MODEL_SOURCE("http://localhost:3000"));
  });

  test("fresh run pushes, deploys, and confirms the heartbeat workflow against the noop source", async () => {
    const { lines, log } = collector();
    const { pushes, push } = recordingPusher();
    let runsCalls = 0;
    let deployedSources: unknown;
    const handler: FakeHandler = (method, path, body) => {
      const base = baseRoutes(method, path);
      if (base) return base;
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`)
        return { status: 201, data: assetRow("ast_3", "heartbeat") };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        deployedSources = body;
        return {
          status: 201,
          data: deploymentRow("dep_3", "ast_3", "deployed"),
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_3/runs`
      ) {
        runsCalls += 1;
        return {
          status: 200,
          data: { runIds: runsCalls === 1 ? [] : ["run_1"] },
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_3/mail`
      )
        return {
          status: 202,
          data: {
            deploymentId: "dep_3",
            address: `ins_dep_3@${TENANT_DOMAIN}`,
            messageId: "<m5@workbench.localhost>",
          },
        };
      return undefined;
    };

    const heartbeatOnly = CATALOG_TEST_WORKFLOWS.filter(
      (w) => w.assetName === "heartbeat",
    );
    await seedTenant(
      args({
        api: fakeAPI(handler),
        pushWorkflow: push,
        log,
        workflows: heartbeatOnly,
      }),
    );

    expect(pushes).toHaveLength(1);
    const push0 = pushes[0];
    if (!push0) throw new Error("expected one workflow push");
    const definition = JSON.parse(push0.workflowJson) as {
      id: string;
      triggers: { type: string; to: string }[];
      stepOrder: string[];
    };
    expect(definition.id).toBe("wf_heartbeat");
    expect(definition.triggers[0]?.to).toBe(`heartbeat@${TENANT_DOMAIN}`);
    expect(definition.stepOrder).toEqual(["heartbeat"]);

    // The deploy's own source, not the tenant's real MODEL, is what
    // proves the noop pin took effect: it must name the noop provider
    // fixture, not the ordinary anthropic/claude-sonnet-4-5 model this
    // test file's `args()` helper hands every other workflow.
    const deployedBody = deployedSources as { sources: { model: string }[] };
    expect(deployedBody.sources[0]?.model).toBe("noop");

    const output = lines.join("\n");
    expect(output).toContain("deployed workflow heartbeat as dep_3");
    expect(output).toContain("confirmed workflow heartbeat: run run_1 started");
  });

  test("the default set includes the channel-digest automation", () => {
    expect(DEFAULT_WORKFLOWS.map((w) => w.assetName)).toContain(
      "channel-digest",
    );
  });

  test("channel-digest is automatable with a friendly display name and no noop pin", () => {
    const channelDigest = DEFAULT_WORKFLOWS.find(
      (w) => w.assetName === "channel-digest",
    );
    if (!channelDigest) throw new Error("expected the channel-digest workflow");
    expect(channelDigest.displayName).toBe("Channel digest");
    expect(channelDigest.automatable).toBe(true);
    expect(channelDigest.modelSource).toBeUndefined();
  });

  test("echo and assistant are not automatable", () => {
    for (const name of ["echo", "assistant"] as const) {
      const workflow = DEFAULT_WORKFLOWS.find((w) => w.assetName === name);
      if (!workflow) throw new Error(`expected ${name}`);
      expect(workflow.automatable).toBe(false);
      expect(workflow.displayName.length).toBeGreaterThan(0);
    }
  });

  test("the catalog-test set is heartbeat only (channel-digest moved to defaults)", () => {
    expect(CATALOG_TEST_WORKFLOWS.map((w) => w.assetName)).toEqual([
      "heartbeat",
    ]);
  });

  test("fresh run pushes, deploys, and confirms the channel-digest workflow against the tenant model", async () => {
    const { lines, log } = collector();
    const { pushes, push } = recordingPusher();
    let runsCalls = 0;
    let deployedSources: unknown;
    const handler: FakeHandler = (method, path, body) => {
      const base = baseRoutes(method, path);
      if (base) return base;
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`)
        return { status: 201, data: assetRow("ast_4", "channel-digest") };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        deployedSources = body;
        return {
          status: 201,
          data: deploymentRow("dep_4", "ast_4", "deployed"),
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_4/runs`
      ) {
        runsCalls += 1;
        return {
          status: 200,
          data: { runIds: runsCalls === 1 ? [] : ["run_1"] },
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_4/mail`
      )
        return {
          status: 202,
          data: {
            deploymentId: "dep_4",
            address: `ins_dep_4@${TENANT_DOMAIN}`,
            messageId: "<m6@workbench.localhost>",
          },
        };
      return undefined;
    };

    const digestOnly = DEFAULT_WORKFLOWS.filter(
      (w) => w.assetName === "channel-digest",
    );
    await seedTenant(
      args({
        api: fakeAPI(handler),
        pushWorkflow: push,
        log,
        workflows: digestOnly,
      }),
    );

    expect(pushes).toHaveLength(1);
    const push0 = pushes[0];
    if (!push0) throw new Error("expected one workflow push");
    const definition = JSON.parse(push0.workflowJson) as {
      id: string;
      triggers: { type: string; to: string }[];
      stepOrder: string[];
    };
    expect(definition.id).toBe("wf_channel_digest");
    expect(definition.triggers[0]?.to).toBe(`channel-digest@${TENANT_DOMAIN}`);
    expect(definition.stepOrder).toEqual(["channel-digest"]);

    // Defaults deploy against the tenant's real model (not noop).
    const deployedBody = deployedSources as { sources: { model: string }[] };
    expect(deployedBody.sources[0]?.model).not.toBe("noop");

    const output = lines.join("\n");
    expect(output).toContain("deployed workflow channel-digest as dep_4");
    expect(output).toContain(
      "confirmed workflow channel-digest: run run_1 started",
    );
  });

  test("confirmDeployments: false deploys every default workflow without triggering or confirming any of them", async () => {
    // The onboarding connect flow's seam: the key was already proven
    // with a free probe, so seeding must never spend the connecting
    // user's own balance on a real inference call. Any POST to a
    // workflow's mail-trigger endpoint here is exactly the bug this
    // flag exists to prevent, so the fake handler fails the test the
    // moment one arrives instead of quietly answering it.
    const { lines, log } = collector();
    const { pushes, push } = recordingPusher();
    const handler: FakeHandler = (method, path, body) => {
      const base = baseRoutes(method, path);
      if (base) return base;
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`) {
        const name = (body as { name: string }).name;
        return { status: 201, data: assetRow(`ast_${name}`, name) };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return {
          status: 201,
          data: deploymentRow("dep_x", "ast_x", "deployed"),
        };
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/workflows/`) &&
        path.endsWith("/runs")
      ) {
        throw new Error(
          `unexpected run-listing call with confirmDeployments: false — ${method} ${path}`,
        );
      }
      if (
        method === "POST" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/workflows/`) &&
        path.endsWith("/mail")
      ) {
        throw new Error(
          `unexpected workflow trigger call with confirmDeployments: false — ${method} ${path}`,
        );
      }
      return undefined;
    };

    await seedTenant(
      args({
        api: fakeAPI(handler),
        pushWorkflow: push,
        log,
        confirmDeployments: false,
      }),
    );

    expect(pushes).toHaveLength(DEFAULT_WORKFLOWS.length);
    const output = lines.join("\n");
    for (const workflow of DEFAULT_WORKFLOWS) {
      expect(output).not.toContain(`confirmed workflow ${workflow.assetName}`);
    }
    expect(output).toContain(
      `seed complete: ${DEFAULT_WORKFLOWS.length} workflow(s) deployed`,
    );
    expect(output).not.toContain("deployed and confirmed");
  });
});

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function providerRow(id: string, name: string, plugin: string = name) {
  return {
    id,
    tenantId: TENANT_ID,
    name,
    plugin,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function credentialRow(id: string, providerId: string, name: string) {
  return {
    id,
    tenantId: TENANT_ID,
    providerId,
    name,
    type: "api_key",
    status: "active",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function catalogModelRow(id: string, canonicalName: string) {
  return {
    id,
    tenantId: TENANT_ID,
    canonicalName,
    disabled: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function catalogProviderRow(
  id: string,
  name: string,
  credentialId: string,
  plugin: string = name,
  baseURL = "https://api.anthropic.com",
) {
  return {
    id,
    tenantId: TENANT_ID,
    name,
    plugin,
    baseURL,
    credentialId,
    disabled: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function catalogOfferingRow(id: string, modelId: string, providerId: string) {
  return {
    id,
    tenantId: TENANT_ID,
    modelId,
    providerId,
    priority: 0,
    deploymentTags: [],
    capabilities: [],
    quirks: null,
    disabled: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

describe("seedCatalog", () => {
  test("no apiKey and no placeholderCredential plants only the catalog model", async () => {
    const { lines, log } = collector();
    let providerPosts = 0;
    const handler: FakeHandler = (method, path) => {
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`) {
        providerPosts += 1;
        return { status: 201, data: providerRow("prv_1", "anthropic") };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      )
        return {
          status: 201,
          data: catalogModelRow("mdl_1", "claude-sonnet-5"),
        };
      return undefined;
    };

    await seedCatalog({
      api: fakeAPI(handler),
      cookies: [],
      tenantId: TENANT_ID,
      log,
    });

    expect(providerPosts).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain("created catalog model claude-sonnet-5");
    expect(output).toContain("seeded without a credential");
  });

  test("fresh run creates the full provider-to-offering chain", async () => {
    const { lines, log } = collector();
    const handler: FakeHandler = (method, path, body) => {
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`)
        return { status: 201, data: providerRow("prv_1", "anthropic") };
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/credentials`)
        return {
          status: 201,
          data: credentialRow("cre_1", "prv_1", "anthropic-default"),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      )
        return {
          status: 201,
          data: catalogModelRow("mdl_1", "claude-sonnet-5"),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      )
        return {
          status: 201,
          data: catalogProviderRow("cpv_1", "anthropic", "cre_1"),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      ) {
        expect(body).toEqual({ modelId: "mdl_1", providerId: "cpv_1" });
        return {
          status: 201,
          data: catalogOfferingRow("off_1", "mdl_1", "cpv_1"),
        };
      }
      return undefined;
    };

    await seedCatalog({
      api: fakeAPI(handler),
      cookies: [],
      tenantId: TENANT_ID,
      apiKey: "sk-test",
      log,
    });

    const output = lines.join("\n");
    expect(output).toContain("created provider anthropic");
    expect(output).toContain("created credential anthropic-default");
    expect(output).toContain("created catalog model claude-sonnet-5");
    expect(output).toContain("created catalog provider anthropic");
    expect(output).toContain("created catalog offering");
    expect(output).toContain("catalog ready: anthropic/claude-sonnet-5");
  });

  test("an oauth_token credential with metadata posts both through to the credential row", async () => {
    const { log } = collector();
    let credentialBody: unknown;
    const handler: FakeHandler = (method, path, body) => {
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`)
        return { status: 201, data: providerRow("prv_1", "huggingface") };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/credentials`
      ) {
        credentialBody = body;
        return {
          status: 201,
          data: credentialRow("cre_1", "prv_1", "huggingface-default"),
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      )
        return {
          status: 201,
          data: catalogModelRow("mdl_1", "deepseek-ai/DeepSeek-V4-Flash"),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      )
        return {
          status: 201,
          data: catalogProviderRow(
            "cpv_1",
            "huggingface",
            "cre_1",
            "openai-compatible",
            "https://router.huggingface.co/v1",
          ),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      )
        return {
          status: 201,
          data: catalogOfferingRow("off_1", "mdl_1", "cpv_1"),
        };
      return undefined;
    };

    await seedCatalog({
      api: fakeAPI(handler),
      cookies: [],
      tenantId: TENANT_ID,
      provider: "huggingface",
      apiKey: "hf_oauth_minted",
      credentialType: "oauth_token",
      credentialMetadata: { expiresAt: "2026-08-13T20:00:00.000Z" },
      log,
    });

    expect(credentialBody).toMatchObject({
      type: "oauth_token",
      metadata: { expiresAt: "2026-08-13T20:00:00.000Z" },
    });
  });

  // A reconnect after the expiry sweep has already flipped the stored
  // row to `expired`: the credential name conflicts (409) because the
  // stale row is still there, so this only succeeds if the fresh token
  // and its new expiry are rotated onto that row rather than discarded
  // in favor of reusing the stale one.
  test("a name conflict on an expired oauth_token reconnect rotates the stale row", async () => {
    const { lines, log } = collector();
    let patchCalls = 0;
    let postCredentialCalls = 0;
    let patchBody: unknown;

    const staleCredentialRow = () => ({
      id: "cre_old",
      tenantId: TENANT_ID,
      providerId: "prv_1",
      name: "huggingface-default",
      type: "oauth_token",
      status: "expired",
      metadata: { expiresAt: "2026-01-01T00:00:00.000Z" },
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });

    const handler: FakeHandler = (method, path, body) => {
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`)
        return { status: 201, data: providerRow("prv_1", "huggingface") };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/credentials`
      ) {
        postCredentialCalls += 1;
        // The credential name "huggingface-default" already exists (the
        // expired row from before this reconnect), so creation conflicts.
        return { status: 409, data: { error: "name taken" } };
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/credentials`)
        return {
          status: 200,
          data: { data: [staleCredentialRow()], nextCursor: null },
        };
      if (
        method === "PATCH" &&
        path === `/api/tenants/${TENANT_ID}/credentials/cre_old`
      ) {
        patchCalls += 1;
        patchBody = body;
        return {
          status: 200,
          data: {
            ...staleCredentialRow(),
            status: "active",
            metadata: { expiresAt: "2026-09-01T00:00:00.000Z" },
          },
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      )
        return {
          status: 201,
          data: catalogModelRow("mdl_1", "deepseek-ai/DeepSeek-V4-Flash"),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      )
        return {
          status: 201,
          data: catalogProviderRow(
            "cpv_1",
            "huggingface",
            "cre_old",
            "openai-compatible",
            "https://router.huggingface.co/v1",
          ),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      )
        return {
          status: 201,
          data: catalogOfferingRow("off_1", "mdl_1", "cpv_1"),
        };
      return undefined;
    };

    await seedCatalog({
      api: fakeAPI(handler),
      cookies: [],
      tenantId: TENANT_ID,
      provider: "huggingface",
      apiKey: "hf_freshly_minted_token",
      credentialType: "oauth_token",
      credentialMetadata: { expiresAt: "2026-09-01T00:00:00.000Z" },
      log,
    });

    expect(postCredentialCalls).toBe(1);
    // The fix: the name conflict is followed by a PATCH that carries the
    // freshly minted token, its new expiry, and restores `active` status
    // — never a silent reuse of the stale, already-expired row.
    expect(patchCalls).toBe(1);
    expect(patchBody).toEqual({
      secret: "hf_freshly_minted_token",
      status: "active",
      metadata: { expiresAt: "2026-09-01T00:00:00.000Z" },
    });
    expect(lines.some((line) => line.includes("rotated credential"))).toBe(
      true,
    );
  });

  test("a name conflict on an already-active oauth_token credential is left untouched", async () => {
    const { log } = collector();
    let patchCalls = 0;

    const activeCredentialRow = () => ({
      id: "cre_active",
      tenantId: TENANT_ID,
      providerId: "prv_1",
      name: "huggingface-default",
      type: "oauth_token",
      status: "active",
      metadata: { expiresAt: "2026-09-01T00:00:00.000Z" },
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });

    const handler: FakeHandler = (method, path) => {
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`)
        return { status: 201, data: providerRow("prv_1", "huggingface") };
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/credentials`)
        return { status: 409, data: { error: "name taken" } };
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/credentials`)
        return {
          status: 200,
          data: { data: [activeCredentialRow()], nextCursor: null },
        };
      if (method === "PATCH") {
        patchCalls += 1;
        return { status: 200, data: activeCredentialRow() };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      )
        return {
          status: 201,
          data: catalogModelRow("mdl_1", "deepseek-ai/DeepSeek-V4-Flash"),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      )
        return {
          status: 201,
          data: catalogProviderRow(
            "cpv_1",
            "huggingface",
            "cre_active",
            "openai-compatible",
            "https://router.huggingface.co/v1",
          ),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      )
        return {
          status: 201,
          data: catalogOfferingRow("off_1", "mdl_1", "cpv_1"),
        };
      return undefined;
    };

    await seedCatalog({
      api: fakeAPI(handler),
      cookies: [],
      tenantId: TENANT_ID,
      provider: "huggingface",
      apiKey: "hf_same_token_again",
      credentialType: "oauth_token",
      credentialMetadata: { expiresAt: "2026-09-01T00:00:00.000Z" },
      log,
    });

    // A plain idempotent re-seed of a still-active connection never
    // rotates — only a genuinely stale (non-active) row does.
    expect(patchCalls).toBe(0);
  });

  test("re-run finds every step already seeded and creates nothing twice", async () => {
    const { lines, log } = collector();
    let providerPosts = 0;
    let credentialPosts = 0;
    let modelPosts = 0;
    let catalogProviderPosts = 0;
    let offeringPosts = 0;
    const handler: FakeHandler = (method, path) => {
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`) {
        providerPosts += 1;
        return { status: 409, data: { error: "name taken" } };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/providers?inherited=false`
      )
        return {
          status: 200,
          data: { data: [providerRow("prv_1", "anthropic")], nextCursor: null },
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/credentials`
      ) {
        credentialPosts += 1;
        return { status: 409, data: { error: "name taken" } };
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/credentials`)
        return {
          status: 200,
          data: {
            data: [credentialRow("cre_1", "prv_1", "anthropic-default")],
            nextCursor: null,
          },
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      ) {
        modelPosts += 1;
        return { status: 409, data: { error: "name taken" } };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      )
        return {
          status: 200,
          data: {
            data: [catalogModelRow("mdl_1", "claude-sonnet-5")],
            nextCursor: null,
          },
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      ) {
        catalogProviderPosts += 1;
        return { status: 409, data: { error: "name taken" } };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      )
        return {
          status: 200,
          data: {
            data: [catalogProviderRow("cpv_1", "anthropic", "cre_1")],
            nextCursor: null,
          },
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      ) {
        offeringPosts += 1;
        return { status: 409, data: { error: "already exists" } };
      }
      return undefined;
    };

    await seedCatalog({
      api: fakeAPI(handler),
      cookies: [],
      tenantId: TENANT_ID,
      apiKey: "sk-test",
      log,
    });

    expect(providerPosts).toBe(1);
    expect(credentialPosts).toBe(1);
    expect(modelPosts).toBe(1);
    expect(catalogProviderPosts).toBe(1);
    expect(offeringPosts).toBe(1);

    const output = lines.join("\n");
    expect(output).toContain("provider anthropic already exists (skipped)");
    expect(output).toContain(
      "credential anthropic-default already exists (skipped",
    );
    expect(output).toContain(
      "catalog model claude-sonnet-5 already exists (skipped)",
    );
    expect(output).toContain(
      "catalog provider anthropic already exists (skipped)",
    );
    expect(output).toContain("catalog offering already exists (skipped)");
  });

  test("a non-default provider plants its own curated multi-model catalog under the 'openai-compatible' plugin", async () => {
    const { lines, log } = collector();
    const modelPosts: string[] = [];
    const offeringPosts: { modelId: string; providerId: string }[] = [];
    const handler: FakeHandler = (method, path, body) => {
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      ) {
        const canonicalName = (body as { canonicalName: string }).canonicalName;
        modelPosts.push(canonicalName);
        return {
          status: 201,
          data: catalogModelRow(`mdl_${modelPosts.length}`, canonicalName),
        };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`) {
        expect(body).toMatchObject({
          name: "groq",
          plugin: "openai-compatible",
        });
        return {
          status: 201,
          data: providerRow("prv_1", "groq", "openai-compatible"),
        };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/credentials`)
        return {
          status: 201,
          data: credentialRow("cre_1", "prv_1", "groq-default"),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      ) {
        expect(body).toMatchObject({
          name: "groq",
          plugin: "openai-compatible",
          baseURL: "https://api.groq.com/openai/v1",
        });
        return {
          status: 201,
          data: catalogProviderRow(
            "cpv_1",
            "groq",
            "cre_1",
            "openai-compatible",
            "https://api.groq.com/openai/v1",
          ),
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      ) {
        const offering = body as { modelId: string; providerId: string };
        offeringPosts.push(offering);
        return {
          status: 201,
          data: catalogOfferingRow(
            `off_${offeringPosts.length}`,
            offering.modelId,
            offering.providerId,
          ),
        };
      }
      return undefined;
    };

    await seedCatalog({
      api: fakeAPI(handler),
      cookies: [],
      tenantId: TENANT_ID,
      provider: "groq",
      apiKey: "gsk-test",
      log,
    });

    expect(modelPosts).toEqual([
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "openai/gpt-oss-120b",
    ]);
    expect(offeringPosts).toHaveLength(3);
    expect(offeringPosts.every((o) => o.providerId === "cpv_1")).toBe(true);

    const output = lines.join("\n");
    expect(output).toContain(
      "catalog ready: groq/llama-3.3-70b-versatile, llama-3.1-8b-instant, openai/gpt-oss-120b",
    );
  });

  test("an unexpected status from the provider route is a loud failure", async () => {
    const { log } = collector();
    const handler: FakeHandler = (method, path) => {
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      )
        return {
          status: 201,
          data: catalogModelRow("mdl_1", "claude-sonnet-5"),
        };
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`)
        return { status: 500, data: { error: "boom" } };
      return undefined;
    };

    expect(
      seedCatalog({
        api: fakeAPI(handler),
        cookies: [],
        tenantId: TENANT_ID,
        apiKey: "sk-test",
        log,
      }),
    ).rejects.toThrow(CliError);
  });
});
