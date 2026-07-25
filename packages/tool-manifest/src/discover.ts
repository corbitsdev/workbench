import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Build-time-only filesystem walk: which workspace groups may ship tool
// packages. `packages/*` for shared workbench packages, `workflows/*` so a
// workflow package can ship its own tools alongside its definition.
// `apps/*` are thin hosts per AGENTS.md and never own tool
// source; `interchange/` is upstream and out of scope.
//
// This module touches `node:fs`/`node:path` and is deliberately NOT
// re-exported from `./index` — the web app's browser bundle reaches
// `@workbench/tool-manifest` through `@workbench/agents/browser`, and Vite
// shims node builtins to empty modules (see
// `packages/agents/src/browser-node-free.test.ts`). Build scripts import
// this file directly (`@workbench/tool-manifest/discover`).
const TOOL_DISCOVERY_GROUPS = ["packages", "workflows"] as const;

function packageHasToolManifest(packageJsonPath: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(packageJsonPath, "utf8")) as unknown;
    const interchange = (raw as { interchange?: { manifest?: string } })
      .interchange;
    return typeof interchange?.manifest === "string";
  } catch {
    return false;
  }
}

/**
 * Every workspace member directory that declares `interchange.manifest`,
 * selected purely on that declaration — never on a `tools-` name prefix.
 * Returns paths relative to `repoRoot` in POSIX form (e.g.
 * `"packages/tools-artifact"`, `"workflows/exa-topic-watch"`), sorted.
 */
export function discoverToolPackageDirs(repoRoot: string): string[] {
  const dirs: string[] = [];
  for (const group of TOOL_DISCOVERY_GROUPS) {
    const groupDir = join(repoRoot, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgJsonPath = join(groupDir, entry.name, "package.json");
      if (existsSync(pkgJsonPath) && packageHasToolManifest(pkgJsonPath)) {
        dirs.push(`${group}/${entry.name}`);
      }
    }
  }
  return dirs.sort();
}
