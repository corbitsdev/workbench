// This package is installable data on the native workflow contract:
// its shipped sources import only published platform packages, so the
// source tree plus the package manifest deploys on any Interchange
// instance without a wrapper contract. Tool packages this workflow
// expects at deploy time (@corbits/reddit-tools) are pinned by the
// deployer, never imported here — see src/index.ts's header comment.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "bun:test";

const ALLOWED_IMPORT_PREFIXES = ["@intx/", "arktype", "./", "../"];

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

async function shippedFiles(): Promise<string[]> {
  const packageRoot = path.join(import.meta.dir, "..");
  return [
    ...(await listFiles(path.join(packageRoot, "src"))),
    path.join(packageRoot, "package.json"),
  ];
}

test("shipped sources import only published platform packages", async () => {
  const importPattern = /from\s+"([^"]+)"/g;
  const violations: string[] = [];
  for (const file of await shippedFiles()) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const content = await readFile(file, "utf8");
    for (const match of content.matchAll(importPattern)) {
      const specifier = match[1] ?? "";
      const allowed = ALLOWED_IMPORT_PREFIXES.some((prefix) =>
        specifier.startsWith(prefix),
      );
      if (!allowed) {
        violations.push(`${path.basename(file)}: ${specifier}`);
      }
    }
  }
  expect(violations).toEqual([]);
});
