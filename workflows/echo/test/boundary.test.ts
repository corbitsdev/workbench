// This package is installable data on the native workflow contract.
// It must contain no reference to the host application, no product
// naming, and no wrapper contract: its shipped sources import only
// published platform packages. The source tree plus the package
// manifest IS the deployable unit this test guards.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "bun:test";

const FORBIDDEN_TERMS = [
  "workbench",
  "scout",
  "corbits",
  "gtm",
  "jimmy",
  "diligence",
  "tenant",
  "hub",
  "sidecar",
];

const ALLOWED_IMPORT_PREFIXES = ["@intx/", "./", "../"];

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

test("shipped sources contain no host or product strings", async () => {
  const hits: string[] = [];
  for (const file of await shippedFiles()) {
    const content = (await readFile(file, "utf8")).toLowerCase();
    for (const term of FORBIDDEN_TERMS) {
      if (content.includes(term)) {
        hits.push(`${path.basename(file)}: ${term}`);
      }
    }
  }
  expect(hits).toEqual([]);
});

test("shipped sources import only published platform packages", async () => {
  const importPattern = /from\s+"([^"]+)"/g;
  const violations: string[] = [];
  for (const file of await shippedFiles()) {
    if (!file.endsWith(".ts")) continue;
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
