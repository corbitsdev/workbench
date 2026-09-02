// Regression for CL-7363: Agent Builder definitions used to self-freeze
// through `@corbits/workflow-freeze`'s `DefinitionFreezer`, a hub-local
// path that bypasses the native sidecar probe. This package now deploys
// every definition write through the injected `WorkflowDeployer` — the
// SAME seam `@corbits/agent-workflow-authoring`'s own registry calls
// (`sessionService.deployWorkflowFromSource`, install -> sidecar probe
// -> gate -> freeze) — so `@corbits/workflow-freeze` must never again
// appear in this package's source or its dependency manifest.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const SRC_DIR = path.join(import.meta.dir, ".");

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFilesUnder(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [full]
      : [];
  });
}

describe("workflow-freeze cutover", () => {
  test("no source file in this package imports @corbits/workflow-freeze", () => {
    const offenders = tsFilesUnder(SRC_DIR).filter((file) =>
      readFileSync(file, "utf8").includes("@corbits/workflow-freeze"),
    );
    expect(offenders).toEqual([]);
  });

  test("package.json declares no @corbits/workflow-freeze dependency", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(import.meta.dir, "../package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(packageJson.dependencies ?? {})).not.toContain(
      "@corbits/workflow-freeze",
    );
  });
});
