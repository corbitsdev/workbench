// Builds an on-disk staging directory that becomes the E2B build context.
//
// This is an allowlist, not a denylist: the only repository paths ever read
// are the root manifest/lockfile and the workspace glob roots declared in
// the root package.json (`apps/*`, `packages/*`, `tools/*`, `vendor/intx/*`,
// `workflows/*`). Directories such as `.data`, `.env*`, `.worktrees`, and
// `.git` are never enumerated, so a future secret-bearing directory added
// outside those roots cannot leak into the image no matter what it
// contains. Within the workspace roots, only the packages `apps/sidecar`
// actually depends on (SIDECAR_FULL_SOURCE_DIRS) get their source copied;
// every other workspace member contributes just its `package.json`, which
// is enough for `bun install --frozen-lockfile` to resolve the whole
// workspace graph (see the package.json-stub test in build-context.test.ts
// for the proof).

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { copyFileSync } from "node:fs";
import { join, posix } from "node:path";

export const WORKSPACE_GLOB_ROOTS = [
  "apps",
  "packages",
  "tools",
  "vendor/intx",
  "workflows",
] as const;

// The transitive workspace-package closure of `apps/sidecar`'s
// `dependencies` (computed by walking package.json workspace:* deps
// starting from @workbench/sidecar). Anything not listed here ships as a
// package.json-only stub.
export const SIDECAR_FULL_SOURCE_DIRS = [
  "apps/sidecar",
  "packages/agent-lifecycle",
  "packages/credential-providers",
  "vendor/intx/agent",
  "vendor/intx/authz",
  "vendor/intx/crypto",
  "vendor/intx/db",
  "vendor/intx/harness",
  "vendor/intx/hub-agent",
  "vendor/intx/hub-common",
  "vendor/intx/hub-sessions",
  "vendor/intx/inference",
  "vendor/intx/log",
  "vendor/intx/mail-memory",
  "vendor/intx/mime",
  "vendor/intx/pack-transport",
  "vendor/intx/storage-isogit",
  "vendor/intx/tool-packaging",
  "vendor/intx/types",
  "vendor/intx/workflow",
  "vendor/intx/workflow-deploy",
  "vendor/intx/workflow-host",
] as const;

const FULL_SOURCE_COPY_EXCLUDES = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".turbo",
]);

function listWorkspaceMemberDirs(
  repositoryRoot: string,
  globRoot: string,
): string[] {
  const absoluteGlobRoot = join(repositoryRoot, ...globRoot.split("/"));
  if (!existsSync(absoluteGlobRoot)) {
    return [];
  }
  return readdirSync(absoluteGlobRoot)
    .filter((entry) => {
      const entryPath = join(absoluteGlobRoot, entry);
      return (
        statSync(entryPath).isDirectory() &&
        existsSync(join(entryPath, "package.json"))
      );
    })
    .map((entry) => posix.join(globRoot, entry));
}

export function listWorkspaceMembers(repositoryRoot: string): string[] {
  return WORKSPACE_GLOB_ROOTS.flatMap((globRoot) =>
    listWorkspaceMemberDirs(repositoryRoot, globRoot),
  );
}

function copyFullSource(
  repositoryRoot: string,
  relativeDir: string,
  destinationRoot: string,
) {
  const src = join(repositoryRoot, ...relativeDir.split("/"));
  const dest = join(destinationRoot, ...relativeDir.split("/"));
  cpSync(src, dest, {
    recursive: true,
    filter: (candidate) => {
      const base = candidate.split("/").pop() ?? "";
      return !FULL_SOURCE_COPY_EXCLUDES.has(base);
    },
  });
}

function copyManifestStub(
  repositoryRoot: string,
  relativeDir: string,
  destinationRoot: string,
) {
  const srcManifest = join(
    repositoryRoot,
    ...relativeDir.split("/"),
    "package.json",
  );
  const destDir = join(destinationRoot, ...relativeDir.split("/"));
  mkdirSync(destDir, { recursive: true });
  copyFileSync(srcManifest, join(destDir, "package.json"));
}

// Stages the exact tree the image needs at `destinationDir`. Only ever
// reads: repositoryRoot/package.json, repositoryRoot/bun.lock, and the
// workspace glob roots above.
export function stageBuildContext(
  repositoryRoot: string,
  destinationDir: string,
) {
  mkdirSync(destinationDir, { recursive: true });
  copyFileSync(
    join(repositoryRoot, "package.json"),
    join(destinationDir, "package.json"),
  );
  copyFileSync(
    join(repositoryRoot, "bun.lock"),
    join(destinationDir, "bun.lock"),
  );

  const fullSourceDirs = new Set<string>(SIDECAR_FULL_SOURCE_DIRS);
  for (const member of listWorkspaceMembers(repositoryRoot)) {
    if (fullSourceDirs.has(member)) {
      copyFullSource(repositoryRoot, member, destinationDir);
    } else {
      copyManifestStub(repositoryRoot, member, destinationDir);
    }
  }
}
