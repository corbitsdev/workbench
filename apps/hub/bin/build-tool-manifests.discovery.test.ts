import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectToolFactoryManifests,
  discoverToolPackageDirs,
} from "./build-tool-manifests.ts";

// Discovery must select on the presence of `interchange.tools` in a workspace
// member's package.json, across both `packages/*` and `workflows/*` — not on
// a `tools-` name prefix (CL-4463). These fixtures build a throwaway repo
// root so the real filesystem-walk/import code path is exercised end to end,
// without touching the committed manifest tree.

function writeToolManifestModule(dir: string, factoryId: string): void {
  writeFileSync(
    join(dir, "tool-manifest.ts"),
    [
      "export const toolManifestFile = {",
      "  factories: [",
      "    {",
      `      factoryId: ${JSON.stringify(factoryId)},`,
      `      packageName: ${JSON.stringify(factoryId.split("/").slice(0, 2).join("/"))},`,
      "      providerName: null,",
      '      bareToolNames: ["fixture_tool"],',
      '      sideEffects: { fixture_tool: "read" },',
      "    },",
      "  ],",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
}

function writeToolPackage(
  root: string,
  group: "packages" | "workflows",
  name: string,
  scope: string,
): string {
  const dir = join(root, group, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: `${scope}/${name}`,
        version: "0.0.0",
        type: "module",
        interchange: {
          tools: "./dist/interchange-tools.js",
          manifest: "./tool-manifest.ts",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  writeToolManifestModule(dir, `${scope}/${name}/fixture`);
  return dir;
}

function writeNonToolPackage(
  root: string,
  group: "packages" | "workflows",
  name: string,
  scope: string,
): string {
  const dir = join(root, group, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      { name: `${scope}/${name}`, version: "0.0.0", type: "module" },
      null,
      2,
    ),
    "utf8",
  );
  return dir;
}

describe("discoverToolPackageDirs / collectToolFactoryManifests (fixture repo)", () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("discovers a tool declared by a workflows/* package", async () => {
    root = mkdtempSync(join(tmpdir(), "tool-discovery-"));
    const workflowDir = writeToolPackage(
      root,
      "workflows",
      "fixture-workflow",
      "@workbench",
    );

    const dirs = discoverToolPackageDirs(root);
    expect(dirs).toContain(workflowDir);

    const factories = await collectToolFactoryManifests(root);
    expect(factories.map((f) => f.factoryId)).toContain(
      "@workbench/fixture-workflow/fixture",
    );
  });

  test("discovers a tool declared by a packages/* package", async () => {
    root = mkdtempSync(join(tmpdir(), "tool-discovery-"));
    const packageDir = writeToolPackage(
      root,
      "packages",
      "fixture-tools",
      "@workbench",
    );

    const dirs = discoverToolPackageDirs(root);
    expect(dirs).toContain(packageDir);

    const factories = await collectToolFactoryManifests(root);
    expect(factories.map((f) => f.factoryId)).toContain(
      "@workbench/fixture-tools/fixture",
    );
  });

  test("ignores a package without interchange.tools, in either group", async () => {
    root = mkdtempSync(join(tmpdir(), "tool-discovery-"));
    const plainWorkflow = writeNonToolPackage(
      root,
      "workflows",
      "plain-workflow",
      "@workbench",
    );
    const plainPackage = writeNonToolPackage(
      root,
      "packages",
      "plain-package",
      "@workbench",
    );

    const dirs = discoverToolPackageDirs(root);
    expect(dirs).not.toContain(plainWorkflow);
    expect(dirs).not.toContain(plainPackage);

    const factories = await collectToolFactoryManifests(root);
    expect(factories).toEqual([]);
  });

  test("discovered directory is exactly the real one for both groups", () => {
    root = mkdtempSync(join(tmpdir(), "tool-discovery-"));
    const packageDir = writeToolPackage(
      root,
      "packages",
      "fixture-tools",
      "@workbench",
    );
    const workflowDir = writeToolPackage(
      root,
      "workflows",
      "fixture-workflow",
      "@workbench",
    );

    const dirs = discoverToolPackageDirs(root);
    expect([...dirs].sort()).toEqual([packageDir, workflowDir].sort());
  });
});
