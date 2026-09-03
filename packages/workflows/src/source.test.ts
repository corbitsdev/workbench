import { expect, test } from "bun:test";

import {
  parseWorkflowSourceEntry,
  readWorkflowSourceDefinition,
  renderWorkflowSourceTree,
  RetiredWorkflowEnvelopeError,
  WORKFLOW_SOURCE_ENTRY,
} from "./source";

const WORKFLOW_JSON = JSON.stringify({ id: "wf_agent_research-buddy" });

test("the rendered tree is a manifest naming the entry plus the entry itself", () => {
  const tree = renderWorkflowSourceTree({
    packageName: "@workbench-agent/research-buddy",
    workflowJson: WORKFLOW_JSON,
  });

  expect(Object.keys(tree).sort()).toEqual(["package.json", "workflow.js"]);
  const manifest = JSON.parse(tree["package.json"] as string) as {
    name: string;
    interchange: { workflow: string };
  };
  expect(manifest.name).toBe("@workbench-agent/research-buddy");
  expect(manifest.interchange.workflow).toBe(WORKFLOW_SOURCE_ENTRY);
});

test("the definition round-trips through the entry module", () => {
  const tree = renderWorkflowSourceTree({
    packageName: "@workbench-agent/research-buddy",
    workflowJson: WORKFLOW_JSON,
  });

  expect(parseWorkflowSourceEntry(tree["workflow.js"] as string, "ast_1")).toBe(
    WORKFLOW_JSON,
  );
});

test("a bare workflow.json envelope parses as the named retirement error", () => {
  expect(() => parseWorkflowSourceEntry(WORKFLOW_JSON, "ast_1")).toThrow(
    RetiredWorkflowEnvelopeError,
  );
});

test("an asset with no entry module reads as the named retirement error", async () => {
  const reader = {
    readAssetBlob: (params: { assetId: string; path: string }) =>
      Promise.reject(
        new Error(`asset ${params.assetId} has no blob at ${params.path}`),
      ),
  };

  await expect(readWorkflowSourceDefinition(reader, "ast_1")).rejects.toThrow(
    RetiredWorkflowEnvelopeError,
  );
});

test("reading a source-form asset answers its serialized definition", async () => {
  const tree = renderWorkflowSourceTree({
    packageName: "@workbench-agent/research-buddy",
    workflowJson: WORKFLOW_JSON,
  });
  const reader = {
    readAssetBlob: (params: { assetId: string; path: string }) =>
      Promise.resolve(new TextEncoder().encode(tree[params.path] as string)),
  };

  expect(await readWorkflowSourceDefinition(reader, "ast_1")).toBe(
    WORKFLOW_JSON,
  );
});
