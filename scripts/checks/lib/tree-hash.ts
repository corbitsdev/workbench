// Deterministic content hash of a directory tree: sha256 over the
// sorted relative file paths, each followed by NUL and the file bytes.
// node_modules trees, dist/ build output, and *.tsbuildinfo files are
// install/build artifacts, never content, and are excluded so the hash
// is stable across machines and unaffected by whether a typecheck ran
// first — a composite package's tsc --build run writes declaration
// output to dist/ as a side effect, and that output must never be
// mistaken for a vendored source edit.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export function hashDirectory(dir: string): string {
  const relativeFiles = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.split(path.sep).join("/"))
    .filter((entry) => !entry.split("/").includes("node_modules"))
    .filter((entry) => !entry.split("/").includes("dist"))
    .filter((entry) => !entry.endsWith(".tsbuildinfo"))
    .filter((entry) => statSync(path.join(dir, entry)).isFile())
    .sort();
  const hash = createHash("sha256");
  for (const relativeFile of relativeFiles) {
    hash.update(relativeFile);
    hash.update("\0");
    hash.update(readFileSync(path.join(dir, relativeFile)));
  }
  return hash.digest("hex");
}
