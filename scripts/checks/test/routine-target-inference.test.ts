import { expect, test } from "bun:test";
import {
  auditRoutineTargetInference,
  auditWorkflowJsonLiteral,
} from "../routine-target-inference";

test("clean files pass with no violations", () => {
  const report = auditRoutineTargetInference([
    {
      relPath: "apps/web/src/shell/routine-panel.tsx",
      contents: "const target = definitionAssetId;",
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("agents[0]?.definitionId is a violation naming the file", () => {
  const report = auditRoutineTargetInference([
    {
      relPath: "apps/web/src/shell/routine-panel.tsx",
      contents: "const target = agents[0]?.definitionId;",
    },
  ]);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain(
    "apps/web/src/shell/routine-panel.tsx",
  );
});

test("agents[0].definitionId (no optional chain) is also a violation", () => {
  const report = auditRoutineTargetInference([
    {
      relPath: "packages/chat-ui/src/composer.tsx",
      contents: "const target = agents[0].definitionId;",
    },
  ]);
  expect(report.violations).toHaveLength(1);
});

test("agents[0] used for something other than definitionId is not a violation", () => {
  const report = auditRoutineTargetInference([
    {
      relPath: "packages/chat-ui/src/composer.tsx",
      contents: "const target = agents[0];",
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("a workflow.json string literal is a violation naming the file", () => {
  const report = auditWorkflowJsonLiteral([
    {
      relPath: "apps/hub/src/index.ts",
      contents: 'readAssetBlob({ path: "workflow.json" });',
    },
  ]);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("apps/hub/src/index.ts");
});

test("a backtick-quoted mention of workflow.json inside a comment is not a violation", () => {
  const report = auditWorkflowJsonLiteral([
    {
      relPath: "apps/hub/src/index.ts",
      contents: "// never the retired `workflow.json` envelope again",
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("workflow-source's own RetiredWorkflowEnvelopeError file is allowed", () => {
  const report = auditWorkflowJsonLiteral([
    {
      relPath: "packages/workflows/src/source.ts",
      contents: 'const RETIRED_WORKFLOW_ENVELOPE_PATH = "workflow.json";',
    },
  ]);
  expect(report.violations).toEqual([]);
});
