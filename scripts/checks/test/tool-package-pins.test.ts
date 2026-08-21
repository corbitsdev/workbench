import { expect, test } from "bun:test";
import { auditToolPackagePins, extractPins } from "../tool-package-pins";

test("extractPins reads a single-line array-entry pin literal", () => {
  const contents = [
    "export const PINS = [",
    '  { name: "@corbits/memory-tools", version: "0.0.4" },',
    '  { name: "@corbits/mcp-tools", version: "0.0.8" },',
    "];",
  ].join("\n");
  const pins = extractPins("workflows/assistant/src/index.ts", contents);
  expect(pins).toEqual([
    {
      relPath: "workflows/assistant/src/index.ts",
      line: 2,
      name: "@corbits/memory-tools",
      version: "0.0.4",
    },
    {
      relPath: "workflows/assistant/src/index.ts",
      line: 3,
      name: "@corbits/mcp-tools",
      version: "0.0.8",
    },
  ]);
});

test("extractPins reads a multi-line, trailing-comma pin literal", () => {
  const contents = [
    "export const SKILLS_TOOL_PACKAGE_PIN = {",
    '  name: "@corbits/tools-skills",',
    '  version: "0.0.1",',
    "} as const;",
  ].join("\n");
  const pins = extractPins(
    "packages/agent-directory/src/agent-workflow.ts",
    contents,
  );
  expect(pins).toEqual([
    {
      relPath: "packages/agent-directory/src/agent-workflow.ts",
      line: 1,
      name: "@corbits/tools-skills",
      version: "0.0.1",
    },
  ]);
});

test("extractPins ignores non-@corbits and non-pin-shaped object literals", () => {
  const contents = [
    '{ assetName: "granola-call", version: "0.0.1" }',
    '{ name: `${recording.server}-fake`, version: "0.0.1" }',
  ].join("\n");
  expect(extractPins("irrelevant.ts", contents)).toEqual([]);
});

test("a pin matching its package's manifest version is not a violation", () => {
  const report = auditToolPackagePins(
    [
      {
        relPath: "workflows/assistant/src/index.ts",
        line: 47,
        name: "@corbits/agent-directory-tools",
        version: "0.0.4",
      },
    ],
    new Map([["@corbits/agent-directory-tools", "0.0.4"]]),
  );
  expect(report.violations).toEqual([]);
});

test("a pin behind its package's manifest version is a violation naming the file, line, and fix", () => {
  const report = auditToolPackagePins(
    [
      {
        relPath: "workflows/assistant/src/index.ts",
        line: 49,
        name: "@corbits/connections-tools",
        version: "0.0.4",
      },
    ],
    new Map([["@corbits/connections-tools", "0.0.5"]]),
  );
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("workflows/assistant/src/index.ts:49");
  expect(report.violations[0]).toContain("0.0.4");
  expect(report.violations[0]).toContain("0.0.5");
});

test("a pin naming a package with no workspace manifest is a violation", () => {
  const report = auditToolPackagePins(
    [
      {
        relPath: "workflows/assistant/src/index.ts",
        line: 60,
        name: "@corbits/does-not-exist",
        version: "0.0.1",
      },
    ],
    new Map([["@corbits/agent-directory-tools", "0.0.4"]]),
  );
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("@corbits/does-not-exist");
  expect(report.violations[0]).toContain("no workspace package");
});
