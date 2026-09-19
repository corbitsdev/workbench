import { expect, test } from "bun:test";

import {
  readWorkflowSourceDefinition,
  renderBundledWorkflowSourceTree,
  RetiredWorkflowEnvelopeError,
  WORKFLOW_SOURCE_DIRECTORS,
  WORKFLOW_SOURCE_ENTRY,
} from "./source";

const WORKFLOW_JSON = JSON.stringify({ id: "wf_agent_research-buddy" });

function readerFor(tree: Readonly<Record<string, string>>) {
  return {
    readAssetBlob: (params: { assetId: string; path: string }) => {
      const content = tree[params.path];
      if (content === undefined) return Promise.reject(new Error(`no blob at ${params.path}`));
      return Promise.resolve(new TextEncoder().encode(content));
    },
  };
}

test("the rendered tree is a manifest, the entry, and the definition projection", () => {
  const tree = renderBundledWorkflowSourceTree({
    packageName: "@workbench-agent/research-buddy",
    bundle: "export function build(input) { return input; }",
    directorsBundle: "export const noop = null;\n",
    buildExport: "build",
    buildInput: { id: "wf_agent_research-buddy" },
    workflowJson: WORKFLOW_JSON,
  });

  expect(Object.keys(tree).sort()).toEqual([
    "definition.json",
    "directors.js",
    "package.json",
    "workflow.js",
  ]);
  const manifest = JSON.parse(tree["package.json"] as string) as {
    name: string;
    interchange: { workflow: string; directors: string };
  };
  expect(manifest.name).toBe("@workbench-agent/research-buddy");
  expect(manifest.interchange.workflow).toBe(WORKFLOW_SOURCE_ENTRY);
  expect(manifest.interchange.directors).toBe(WORKFLOW_SOURCE_DIRECTORS);
});

test("a bundled entry evaluates the bundle's build export and still projects the definition", async () => {
  const tree = renderBundledWorkflowSourceTree({
    packageName: "@workbench-agent/research-buddy",
    bundle: "export function build(input) { return { id: input.id }; }",
    directorsBundle: "export const noop = null;\n",
    buildExport: "build",
    buildInput: { id: "wf_agent_research-buddy" },
    workflowJson: WORKFLOW_JSON,
  });

  // The entry is code the platform evaluates, so the projection — not a
  // slice of the entry — is what readers get back.
  expect(tree["workflow.js"]).toContain('export default build({"id":"wf_agent_research-buddy"});');
  expect(await readWorkflowSourceDefinition(readerFor(tree), "ast_1")).toBe(WORKFLOW_JSON);
});

test("an asset with no definition projection reads as the named retirement error", async () => {
  await expect(readWorkflowSourceDefinition(readerFor({}), "ast_1")).rejects.toThrow(
    RetiredWorkflowEnvelopeError,
  );
});

test("reading a source-form asset answers its serialized definition", async () => {
  const tree = renderBundledWorkflowSourceTree({
    packageName: "@workbench-agent/research-buddy",
    bundle: "export function build(input) { return input; }",
    directorsBundle: "export const noop = null;\n",
    buildExport: "build",
    buildInput: { id: "wf_agent_research-buddy" },
    workflowJson: WORKFLOW_JSON,
  });

  expect(await readWorkflowSourceDefinition(readerFor(tree), "ast_1")).toBe(WORKFLOW_JSON);
});
