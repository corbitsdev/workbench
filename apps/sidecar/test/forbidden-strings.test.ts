// The host is generic by contract: no agent names, no workflow names,
// no tenant assumptions, no product branding anywhere in the shipped
// application. The sidecar ships as TypeScript source, so the source
// tree plus the package manifest IS the built output this test guards.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "bun:test";

const FORBIDDEN_TERMS = [
  "scout",
  "corbits",
  "workbench",
  "gtm",
  "jimmy",
  "diligence",
  "tenant",
];

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

test("shipped sidecar sources contain no product strings", async () => {
  const appRoot = path.join(import.meta.dir, "..");
  const files = [
    ...(await listFiles(path.join(appRoot, "src"))),
    ...(await listFiles(path.join(appRoot, "bin"))),
    path.join(appRoot, "package.json"),
  ];
  const hits: string[] = [];
  for (const file of files) {
    const content = (await readFile(file, "utf8")).toLowerCase();
    for (const term of FORBIDDEN_TERMS) {
      if (content.includes(term)) {
        hits.push(`${path.relative(appRoot, file)}: ${term}`);
      }
    }
  }
  expect(hits).toEqual([]);
});
