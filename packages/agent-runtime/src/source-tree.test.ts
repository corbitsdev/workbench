import { describe, expect, test } from "bun:test";

import type { AgentRuntimeConfig } from "./config";
import { buildAgentRuntimeWorkflow } from "./definition";
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
    config: { ...config, ...overrides },
  });
}

describe("renderAgentRuntimeSourceTree", () => {
  test("declares the entry the sidecar evaluates", () => {
    const pkg = JSON.parse(render()["package.json"] ?? "");

    expect(pkg.interchange).toEqual({ workflow: AGENT_RUNTIME_ENTRY_PATH });
    expect(Object.keys(render())).toContain("workflow.js");
  });

  test("declares no dependencies — an asset tree is a standalone codebase with no workspace to resolve against", () => {
    const pkg = JSON.parse(render()["package.json"] ?? "");

    expect(pkg.dependencies).toBeUndefined();
  });

  test("renders the evaluated definition into the entry module's own bytes", () => {
    const entry = render()["workflow.js"] ?? "";

    expect(entry.startsWith("export default {")).toBe(true);
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

  test("the rendered entry parses back to the definition the builder produced", () => {
    const entry = render()["workflow.js"] ?? "";
    const literal = entry.slice(
      "export default ".length,
      entry.lastIndexOf(";"),
    );

    expect(JSON.parse(literal)).toEqual(
      JSON.parse(JSON.stringify(buildAgentRuntimeWorkflow(config))),
    );
  });

  test("renders the section mode's turn timeout into the bytes too", () => {
    const entry =
      render({ mode: { kind: "section", turnTimeoutMs: 45_000 } })[
        "workflow.js"
      ] ?? "";

    expect(entry).toContain('"kind": "onTrigger"');
    expect(entry).toContain("45000");
  });

  test("refuses to render a config the run child would reject", () => {
    expect(() => render({ inferencePreferences: [] })).toThrow(
      /invalid agent-runtime config/,
    );
  });
});
