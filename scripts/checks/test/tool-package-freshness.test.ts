import { describe, expect, test } from "bun:test";

import {
  auditFreshness,
  packagesWithChangedSource,
  readToolPackageNames,
} from "../tool-package-freshness";

const TOOL_PACKAGES = ["github-tools", "memory-tools"];

describe("packagesWithChangedSource", () => {
  test("names a package whose src/ moved", () => {
    expect(
      packagesWithChangedSource(
        ["packages/github-tools/src/client.ts"],
        TOOL_PACKAGES,
      ),
    ).toEqual(["github-tools"]);
  });

  test("ignores tests — they ship no source an agent resolves", () => {
    expect(
      packagesWithChangedSource(
        [
          "packages/github-tools/src/client.test.ts",
          "packages/chat-ui/src/timeline.test.tsx",
        ],
        TOOL_PACKAGES,
      ),
    ).toEqual([]);
  });

  test("ignores everything outside a package's src/", () => {
    expect(
      packagesWithChangedSource(
        [
          "packages/github-tools/README.md",
          "apps/hub/src/index.ts",
          "workflows/code-review/src/index.ts",
        ],
        TOOL_PACKAGES,
      ),
    ).toEqual([]);
  });
});

describe("auditFreshness", () => {
  test("the recurring incident: src moved, version did not", () => {
    const report = auditFreshness([
      { name: "github-tools", baseVersion: "0.0.5", headVersion: "0.0.5" },
    ]);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toContain("packages/github-tools");
    expect(report.violations[0]).toContain("stayed at 0.0.5");
  });

  test("a bumped package passes", () => {
    const report = auditFreshness([
      { name: "github-tools", baseVersion: "0.0.5", headVersion: "0.0.6" },
    ]);
    expect(report.violations).toEqual([]);
  });

  test("a package that did not exist at the base ref is new, not stale", () => {
    const report = auditFreshness([
      { name: "scout-agent", baseVersion: undefined, headVersion: "0.0.1" },
    ]);
    expect(report.violations).toEqual([]);
  });

  test("names every stale package, not just the first", () => {
    const report = auditFreshness([
      { name: "github-tools", baseVersion: "0.0.5", headVersion: "0.0.5" },
      { name: "memory-tools", baseVersion: "0.0.4", headVersion: "0.0.4" },
    ]);
    expect(report.violations).toHaveLength(2);
  });
});

describe("scope", () => {
  test("ignores a workspace package the registry does not publish", () => {
    expect(
      packagesWithChangedSource(
        ["packages/workflow-catalog/src/templates.ts"],
        TOOL_PACKAGES,
      ),
    ).toEqual([]);
  });

  test("reads the publisher's own list so the two cannot disagree", () => {
    const names = readToolPackageNames(`
      export const CORBITS_TOOL_PACKAGE_DIRS: readonly string[] = [
        new URL("../../memory-tools", import.meta.url).pathname,
        new URL("../../github-tools", import.meta.url).pathname,
      ];
    `);
    expect(names).toEqual(["github-tools", "memory-tools"]);
  });
});
