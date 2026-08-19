// Restructured from the private repo faremeter/interchange-e2b-provisioner
// (github.com/faremeter/interchange-e2b-provisioner) at commit c1e3182. We
// now own this code; it is not a vendored path.
//
// Builds the E2B image from THIS repository's own tree: apps/sidecar plus
// the vendored Interchange source it depends on (vendor/intx/*, consumed as
// TypeScript source -- see any vendor/intx/*/VENDORED-FROM, whose exports
// maps already point at ./src/*, so no `--conditions=intx-src` is needed
// here or at runtime). There is no sibling Interchange checkout in this
// repo, unlike the upstream provisioner this was restructured from.
//
// The build context is staged on disk first (see build-context.ts) so the
// image only ever contains an explicit allowlist: apps/sidecar's full
// source, the workspace packages it transitively depends on, and a
// package.json-only stub for every other workspace member (needed for
// `bun install --frozen-lockfile` to resolve the whole workspace graph).
// `.data`, `.env*`, `.worktrees`, and `.git` are never read by the stager,
// so they cannot end up in the image regardless of what they contain.

import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Template } from "e2b";

import { stageBuildContext } from "./build-context";

// oven/bun:1.3.9 pinned explicitly (not `latest` or a bare major/minor) so
// the image is reproducible across builds and matches the Bun version this
// workspace's `engines.bun` and lockfile were produced with.
const BUN_IMAGE_VERSION = "1.3.9";

/** The workspace whose dependency closure is the only one this image needs. */
const SIDECAR_PACKAGE_NAME = "@workbench/sidecar";

export function createSidecarTemplate(
  repositoryRootValue = resolve(import.meta.dir, "../../.."),
) {
  const repositoryRoot = resolve(repositoryRootValue);
  const packageTemplateDir = resolve(import.meta.dir);

  const stagingDirectory = mkdtempSync(join(tmpdir(), "e2b-sidecar-context-"));
  stageBuildContext(repositoryRoot, join(stagingDirectory, "repo"));
  copyFileSync(
    join(packageTemplateDir, "start-sidecar.ts"),
    join(stagingDirectory, "start-sidecar.ts"),
  );

  return (
    Template({
      fileContextPath: stagingDirectory,
      // Defense in depth only: stageBuildContext already never reads these
      // paths, so this list should never have anything to match.
      fileIgnorePatterns: [
        "**/.git/**",
        "**/node_modules/**",
        "**/.env",
        "**/.env.*",
        "**/.data/**",
        "**/.worktrees/**",
        "**/dist/**",
        "**/tmp/**",
        "**/coverage/**",
      ],
    })
      .fromBunImage(BUN_IMAGE_VERSION)
      .setUser("root")
      .makeDir(["/repo", "/opt/interchange-e2b"], {
        user: "root",
        mode: 0o755,
      })
      .copy("repo/", "/repo/", { user: "root" })
      .copy("start-sidecar.ts", "/opt/interchange-e2b/start-sidecar.ts", {
        user: "root",
        mode: 0o500,
      })
      .setWorkdir("/repo")
      // Scoped to the sidecar's own workspace closure. Every workspace
      // member ships a package.json stub so the lockfile resolves, but an
      // unfiltered install then pulls the WHOLE monorepo's dependency graph
      // -- the web app's frontend stack included -- which OOM-killed the
      // build container at 2GB. `--filter` installs only what the sidecar
      // needs, which is also all the image should ever carry.
      .runCmd(`bun install --frozen-lockfile --filter=${SIDECAR_PACKAGE_NAME}`)
  );
}
