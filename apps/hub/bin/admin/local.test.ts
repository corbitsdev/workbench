import { describe, it, expect } from "bun:test";
import {
  buildLocalCommand,
  discoverAgentTemplates,
  localGroups,
  LOCAL_ACTIONS,
  SETUP_GROUP,
  WORKFLOWS_GROUP,
  workflowKindFromPackageName,
  type LocalAction,
} from "./local";

describe("buildLocalCommand", () => {
  it("threads the selected tenant into a tenant-aware action", () => {
    const action: LocalAction = {
      label: "x",
      group: "g",
      script: "seed-credentials.ts",
      tenantAware: true,
    };
    expect(buildLocalCommand(action, "/bin", "gtm", [])).toEqual([
      "run",
      "/bin/seed-credentials.ts",
      "--tenant",
      "gtm",
    ]);
  });

  it("omits the tenant flag for non-tenant-aware actions", () => {
    const action: LocalAction = {
      label: "x",
      group: "g",
      script: "build-tool-packages.ts",
    };
    expect(buildLocalCommand(action, "/bin", "gtm", [])).toEqual([
      "run",
      "/bin/build-tool-packages.ts",
    ]);
  });

  it("places baseArgs and extra args before the tenant flag", () => {
    const action: LocalAction = {
      label: "x",
      group: "g",
      script: "publish-tool-packages.ts",
      baseArgs: ["--from", "dist/tool-packages"],
      tenantAware: true,
    };
    expect(
      buildLocalCommand(action, "/bin", "sales", ["--kind", "foo"]),
    ).toEqual([
      "run",
      "/bin/publish-tool-packages.ts",
      "--from",
      "dist/tool-packages",
      "--kind",
      "foo",
      "--tenant",
      "sales",
    ]);
  });

  it("only the bootstrap superadmin seed is marked bootstrap", () => {
    const bootstrap = LOCAL_ACTIONS.filter((a) => a.bootstrap).map(
      (a) => a.script,
    );
    expect(bootstrap).toEqual(["seed.ts"]);
  });
});

describe("localGroups", () => {
  it("surfaces Workflows as its own resource group with the push and deploy actions", () => {
    const groups = localGroups();
    const workflows = groups.find((g) => g.group === WORKFLOWS_GROUP);
    expect(workflows).toBeDefined();
    expect(workflows?.actions.map((a) => a.script)).toEqual([
      "deploy-workflow.ts",
      "deploy-agent.ts",
    ]);
  });

  it("partitions every local action into exactly one group", () => {
    const groups = localGroups();
    const total = groups.reduce((n, g) => n + g.actions.length, 0);
    expect(total).toBe(LOCAL_ACTIONS.length);
  });

  it("drives the push action from a discovered choices list, not a free-text prompt", () => {
    const push = LOCAL_ACTIONS.find((a) => a.script === "deploy-workflow.ts");
    expect(push?.choices?.flag).toBe("--kind");
    expect(push?.prompt).toBeUndefined();
  });

  it("includes purge-credentials and delete-tenant in the setup group", () => {
    const groups = localGroups();
    const setup = groups.find((g) => g.group === SETUP_GROUP);
    const scripts = setup?.actions.map((a) => a.script) ?? [];
    expect(scripts).toContain("purge-credentials.ts");
    expect(scripts).toContain("delete-tenant.ts");
  });

  it("marks purge-credentials as tenant-aware", () => {
    const action = LOCAL_ACTIONS.find(
      (a) => a.script === "purge-credentials.ts",
    );
    expect(action?.tenantAware).toBe(true);
  });

  it("marks delete-tenant as tenant-aware", () => {
    const action = LOCAL_ACTIONS.find((a) => a.script === "delete-tenant.ts");
    expect(action?.tenantAware).toBe(true);
  });
});

describe("workflowKindFromPackageName", () => {
  it("extracts the kind from a workflow package name", () => {
    expect(
      workflowKindFromPackageName("@workbench/workflow-pain-point-collateral"),
    ).toBe("pain-point-collateral");
  });

  it("returns null for non-workflow package names", () => {
    expect(workflowKindFromPackageName("@workbench/agents")).toBeNull();
    expect(workflowKindFromPackageName("@workbench/workflow-")).toBeNull();
    expect(workflowKindFromPackageName(undefined)).toBeNull();
    expect(workflowKindFromPackageName(42)).toBeNull();
  });
});

describe("discoverAgentTemplates", () => {
  it("returns a sorted list of agent template keys", () => {
    const keys = discoverAgentTemplates();
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toContain("oat");
    expect(keys).toEqual([...keys].sort());
  });
});
