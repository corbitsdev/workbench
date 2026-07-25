import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverToolPackageDirs } from "./discover";

// This is the shared build-time discovery walk consumed by both
// `apps/hub/bin/build-tool-manifests.ts`/`build-tool-packages.ts` (which can
// import it directly) and `dockerfile-tool-copy.ts` (which cannot import
// `apps/hub/bin` and instead has the discovered dirs passed in). It selects
// on `interchange.manifest` presence, not a `tools-` name prefix, and covers
// both `packages/*` and `workflows/*`.

function writeCandidate(
  root: string,
  group: "packages" | "workflows",
  name: string,
  hasManifest: boolean,
): void {
  const dir = join(root, group, name);
  mkdirSync(dir, { recursive: true });
  const pkg: Record<string, unknown> = {
    name: `@workbench/${name}`,
    version: "0.0.0",
    type: "module",
  };
  if (hasManifest) {
    pkg.interchange = {
      tools: "./dist/interchange-tools.js",
      manifest: "./tool-manifest.ts",
    };
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
}

describe("discoverToolPackageDirs", () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("finds a tool package under workflows/*", () => {
    root = mkdtempSync(join(tmpdir(), "discover-"));
    writeCandidate(root, "workflows", "fixture-workflow", true);

    expect(discoverToolPackageDirs(root)).toEqual([
      "workflows/fixture-workflow",
    ]);
  });

  test("finds a tool package under packages/*", () => {
    root = mkdtempSync(join(tmpdir(), "discover-"));
    writeCandidate(root, "packages", "fixture-tools", true);

    expect(discoverToolPackageDirs(root)).toEqual(["packages/fixture-tools"]);
  });

  test("ignores a package without interchange.manifest, in either group", () => {
    root = mkdtempSync(join(tmpdir(), "discover-"));
    writeCandidate(root, "packages", "plain-package", false);
    writeCandidate(root, "workflows", "plain-workflow", false);

    expect(discoverToolPackageDirs(root)).toEqual([]);
  });

  test("returns repo-relative POSIX paths, sorted, for a mix of both groups", () => {
    root = mkdtempSync(join(tmpdir(), "discover-"));
    writeCandidate(root, "workflows", "z-workflow", true);
    writeCandidate(root, "packages", "a-tools", true);
    writeCandidate(root, "packages", "plain", false);

    expect(discoverToolPackageDirs(root)).toEqual([
      "packages/a-tools",
      "workflows/z-workflow",
    ]);
  });
});
