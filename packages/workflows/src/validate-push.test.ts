// Round-trip against the real upstream validator, not our renderer's
// comments about it. `workflowKindHandler.validatePush`
// (`vendor/intx/hub-sessions/src/workflow-kind.ts`) is the only consumer of
// the tree `renderBundledWorkflowSourceTree` writes; nothing else in this
// repo checks the pair stays in sync, so a renderer/validator drift would
// otherwise surface only as a push rejection in production.

import { expect, test } from "bun:test";
import { workflowKindHandler } from "@intx/hub-sessions";

import { renderBundledWorkflowSourceTree } from "./source";

const WORKFLOW_JSON = JSON.stringify({ id: "wf_agent_research-buddy" });

function renderedTree(): Readonly<Record<string, string>> {
  return renderBundledWorkflowSourceTree({
    packageName: "@workbench-agent/research-buddy",
    bundle: "export function build(input) { return input; }",
    buildExport: "build",
    buildInput: { id: "wf_agent_research-buddy" },
    workflowJson: WORKFLOW_JSON,
  });
}

const encoder = new TextEncoder();

/** A minimal in-memory tree reader, matching the shape used by
 * `workflow-run-kind.test.ts` upstream: `readBlob` resolves a root-relative
 * POSIX path to its bytes. */
function readBlobFor(tree: Readonly<Record<string, string>>) {
  return async (path: string): Promise<Uint8Array> => {
    const content = tree[path];
    if (content === undefined) throw new Error(`no such blob: ${path}`);
    return encoder.encode(content);
  };
}

const hubPrincipal = { kind: "hub" as const };

function push(tree: Readonly<Record<string, string>>) {
  return workflowKindHandler.validatePush({
    repoId: { kind: "workflow", id: "ast_1" },
    ref: "refs/heads/main",
    principal: hubPrincipal,
    topLevelTreePaths: Object.keys(tree),
    readBlob: readBlobFor(tree),
    listDir: async () => [],
    priorReadBlob: async () => null,
    priorListDir: async () => [],
  });
}

test("a rendered single-package tree passes the real validatePush", async () => {
  const result = await push(renderedTree());

  expect(result).toEqual({ ok: true });
});

test("the renderer never emits an envelope-only capability-declarations.json", async () => {
  expect(Object.keys(renderedTree())).not.toContain("capability-declarations.json");
});

test("the renderer never commits a node_modules directory", async () => {
  expect(Object.keys(renderedTree())).not.toContain("node_modules");
});

test("the renderer never leaves an envelope-valid workflow.json beside the package.json", async () => {
  // The renderer's only paths are package.json, workflow.js and
  // definition.json; the
  // retired workflow.json envelope path never appears in its output, so the
  // ambiguous-tree rejection has no way to fire against what we emit.
  expect(Object.keys(renderedTree())).not.toContain("workflow.json");
});

test("the renderer's package.json always declares a non-empty, contained interchange.workflow entry", async () => {
  const manifest = JSON.parse(renderedTree()["package.json"] as string) as {
    interchange: { workflow: string };
  };

  expect(manifest.interchange.workflow).toBe("./workflow.js");
});

test("a tree missing package.json is rejected, matching the retired-envelope error", async () => {
  const result = await push({
    "workflow.json": WORKFLOW_JSON,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain("workflow.json envelope form is no longer supported");
});
