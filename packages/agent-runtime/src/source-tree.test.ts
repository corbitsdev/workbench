import { describe, expect, test } from "bun:test";

import type { AgentRuntimeConfig } from "./config";
import { AGENT_RUNTIME_PACKAGE_NAME } from "./pin";
import {
  AGENT_RUNTIME_ENTRY_PATH,
  renderAgentRuntimeSourceTree,
} from "./source-tree";

const config: AgentRuntimeConfig = {
  workflowId: "wf_run_a",
  agentId: "run_a",
  triggerAddress: "run_a@bench.example",
  systemPrompt: "You are helpful.",
  inferencePreferences: [{ provider: "acme", model: "acme-1" }],
  toolPackagePins: [],
  credentialBindings: [],
  mode: { kind: "step" },
};

function render(overrides: Partial<AgentRuntimeConfig> = {}) {
  return renderAgentRuntimeSourceTree({
    packageName: "run-a-workflow",
    runtimeVersion: "0.0.1",
    config: { ...config, ...overrides },
  });
}

describe("renderAgentRuntimeSourceTree", () => {
  test("declares the entry the sidecar evaluates", () => {
    const pkg = JSON.parse(render()["package.json"] ?? "");

    expect(pkg.interchange).toEqual({ workflow: AGENT_RUNTIME_ENTRY_PATH });
    expect(Object.keys(render())).toContain("workflow.js");
  });

  test("pins the versioned runtime package as the tree's one dependency", () => {
    const pkg = JSON.parse(render()["package.json"] ?? "");

    expect(pkg.dependencies).toEqual({ [AGENT_RUNTIME_PACKAGE_NAME]: "0.0.1" });
  });

  test("renders the config into the entry module's own bytes", () => {
    const entry = render()["workflow.js"] ?? "";

    expect(entry).toContain(`from "${AGENT_RUNTIME_PACKAGE_NAME}"`);
    expect(entry).toContain("buildAgentRuntimeWorkflow(");
    expect(entry).toContain('"run_a@bench.example"');
    expect(entry).toContain('"You are helpful."');
  });

  test("a differing per-run field produces differing bytes — the hash barrier's whole premise", () => {
    const a = render()["workflow.js"];
    const b = render({ systemPrompt: "You are terse." })["workflow.js"];

    expect(a).not.toBe(b);
  });

  test("the same config renders byte-identically, so probe and run agree", () => {
    expect(render()).toEqual(render());
  });

  test("the rendered entry's config round-trips back to the config it was given", () => {
    const entry = render()["workflow.js"] ?? "";
    const literal = entry.slice(
      entry.indexOf("buildAgentRuntimeWorkflow(") +
        "buildAgentRuntimeWorkflow(".length,
      entry.lastIndexOf(");"),
    );

    expect(JSON.parse(literal)).toEqual(config);
  });

  test("renders the section mode's turn timeout into the bytes too", () => {
    const entry =
      render({ mode: { kind: "section", turnTimeoutMs: 45_000 } })[
        "workflow.js"
      ] ?? "";

    expect(entry).toContain('"kind": "section"');
    expect(entry).toContain('"turnTimeoutMs": 45000');
  });

  test("refuses to render a config the run child would reject", () => {
    expect(() => render({ inferencePreferences: [] })).toThrow(
      /invalid agent-runtime config/,
    );
  });
});
