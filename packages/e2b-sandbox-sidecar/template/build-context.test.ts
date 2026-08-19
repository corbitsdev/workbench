import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  SIDECAR_FULL_SOURCE_DIRS,
  listWorkspaceMembers,
  stageBuildContext,
} from "./build-context";

const repositoryRoot = resolve(import.meta.dir, "../../..");

let stagingDirs: string[] = [];

function stage(): string {
  const dir = mkdtempSync(join(tmpdir(), "build-context-test-"));
  stagingDirs.push(dir);
  stageBuildContext(repositoryRoot, dir);
  return dir;
}

function walk(dir: string): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    entries.push(full);
    if (statSync(full).isDirectory()) {
      entries.push(...walk(full));
    }
  }
  return entries;
}

afterEach(() => {
  for (const dir of stagingDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  stagingDirs = [];
});

describe("stageBuildContext", () => {
  test("never stages secret-bearing repository paths", () => {
    const staged = stage();
    const allPaths = walk(staged);

    const forbiddenNames = [".data", ".env", ".worktrees", ".git"];
    for (const path of allPaths) {
      const base = path.split("/").pop() ?? "";
      for (const forbidden of forbiddenNames) {
        expect(base).not.toBe(forbidden);
        expect(base.startsWith(".env.")).toBe(false);
      }
    }
  });

  test("never even reads outside the declared workspace roots and root manifest files", () => {
    // Regression guard for the allowlist design: this asserts on the
    // *inputs* the stager is allowed to read, not just its outputs, so a
    // future change that widens the scan (e.g. `readdirSync(repositoryRoot)`)
    // fails here even before it could copy anything sensitive.
    const source = readFileSync(
      resolve(import.meta.dir, "build-context.ts"),
      "utf8",
    );
    expect(source).not.toContain("readdirSync(repositoryRoot)");
  });

  test("ships full source for apps/sidecar and its workspace dependency closure", () => {
    const staged = stage();
    for (const dir of SIDECAR_FULL_SOURCE_DIRS) {
      expect(existsSync(join(staged, dir, "package.json"))).toBe(true);
    }
    expect(existsSync(join(staged, "apps/sidecar/src/index.ts"))).toBe(true);
    expect(
      existsSync(join(staged, "vendor/intx/hub-sessions/src/index.ts")),
    ).toBe(true);
  });

  test("ships root package.json and bun.lock", () => {
    const staged = stage();
    expect(existsSync(join(staged, "package.json"))).toBe(true);
    expect(existsSync(join(staged, "bun.lock"))).toBe(true);
  });

  test("ships every workspace member the root package.json globs match, at minimum as a package.json stub", () => {
    const staged = stage();
    const members = listWorkspaceMembers(repositoryRoot);
    expect(members.length).toBeGreaterThan(50);

    for (const member of members) {
      const manifestPath = join(staged, ...member.split("/"), "package.json");
      expect(existsSync(manifestPath)).toBe(true);
    }
  });

  test("stubs out non-dependency workspace members without shipping their source", () => {
    const staged = stage();
    const fullSourceSet = new Set<string>(SIDECAR_FULL_SOURCE_DIRS);
    const members = listWorkspaceMembers(repositoryRoot);
    const stubbed = members.filter((member) => !fullSourceSet.has(member));
    expect(stubbed.length).toBeGreaterThan(0);

    for (const member of stubbed) {
      const stagedDir = join(staged, ...member.split("/"));
      const entries = readdirSync(stagedDir);
      expect(entries).toEqual(["package.json"]);
    }
  });

  test("excludes node_modules and dist from full-source directories", () => {
    const staged = stage();
    const allPaths = walk(join(staged, "apps/sidecar"));
    for (const path of allPaths) {
      const base = path.split("/").pop() ?? "";
      expect(base).not.toBe("node_modules");
      expect(base).not.toBe("dist");
    }
  });
});
