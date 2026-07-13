import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The web app bundles `@workbench/agents/browser` (and, through it,
// `@workbench/tool-manifest`). Vite shims node builtins to empty modules in a
// browser build, so any `node:*` import reachable from this entrypoint builds
// green but crashes at runtime (e.g. `path.join is not a function`). Walk the
// static import graph and reject node builtins before they reach the bundle.

const NODE_BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "events",
  "fs",
  "http",
  "https",
  "module",
  "net",
  "os",
  "path",
  "process",
  "stream",
  "url",
  "util",
  "worker_threads",
  "zlib",
]);

function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  return NODE_BUILTINS.has(specifier);
}

function isWorkspaceSource(path: string): boolean {
  return !path.includes("node_modules") || path.includes("@workbench/");
}

function collectNodeImports(entry: string): string[] {
  const transpiler = new Bun.Transpiler({ loader: "tsx" });
  const seen = new Set<string>([entry]);
  const queue = [entry];
  const offenders: string[] = [];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined) break;
    const imports = transpiler.scanImports(readFileSync(file, "utf8"));
    for (const imp of imports) {
      if (imp.kind !== "import-statement" && imp.kind !== "dynamic-import") {
        continue;
      }
      if (isNodeBuiltin(imp.path)) {
        offenders.push(`${file} -> ${imp.path}`);
        continue;
      }
      let resolved: string;
      try {
        resolved = Bun.resolveSync(imp.path, dirname(file));
      } catch {
        continue;
      }
      if (!/\.(ts|tsx|js|jsx|mjs)$/.test(resolved)) continue;
      if (!isWorkspaceSource(resolved)) continue;
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push(resolved);
    }
  }
  return offenders;
}

describe("browser entrypoint", () => {
  test("import graph reaches no node builtins", () => {
    const entry = join(import.meta.dir, "browser.ts");
    expect(collectNodeImports(entry)).toEqual([]);
  });
});
