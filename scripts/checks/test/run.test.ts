import { expect, test } from "bun:test";
import path from "node:path";
import { buildChecks, discoverCheckFiles } from "../run";

const REAL_CHECKS_DIR = path.resolve(import.meta.dir, "..");

const files: Record<string, string> = {
  "deletion.ts": "if (import.meta.main) main();",
  "deletion.test.ts": "if (import.meta.main) main();",
  "lib-only.ts": "export function helper() {}",
  "allowlist.ts": "export const ALLOWLIST = [];",
};

function fakeReaddir(_dir: string): string[] {
  return Object.keys(files);
}

function fakeReadFile(file: string): string {
  const name = file.split("/").pop() ?? "";
  return files[name] ?? "";
}

test("discovers only .ts files with an import.meta.main entry point", () => {
  const found = discoverCheckFiles("/checks", fakeReaddir, fakeReadFile);
  expect(found).toEqual(["deletion.ts"]);
});

test("skips .test.ts files even if they have a main entry point", () => {
  expect(
    discoverCheckFiles("/checks", fakeReaddir, fakeReadFile),
  ).not.toContain("deletion.test.ts");
});

test("buildChecks always includes tsconfig-references alongside discovered checks", () => {
  const checks = buildChecks(
    REAL_CHECKS_DIR,
    path.resolve(REAL_CHECKS_DIR, "..", ".."),
  );
  const names = checks.map((check) => check.name);
  expect(names).toContain("tsconfig-references");
  expect(names).toContain("licenses");
  expect(names).toContain("catalog-pins");
  expect(names).not.toContain("react-ui-drift-allowlist");
});

test("buildChecks names are sorted", () => {
  const checks = buildChecks(
    REAL_CHECKS_DIR,
    path.resolve(REAL_CHECKS_DIR, "..", ".."),
  );
  const names = checks.map((check) => check.name);
  expect(names).toEqual([...names].sort());
});

test("never discovers itself (run.ts) as a check — that would recurse without bound", () => {
  const checks = buildChecks(
    REAL_CHECKS_DIR,
    path.resolve(REAL_CHECKS_DIR, "..", ".."),
  );
  expect(checks.map((check) => check.name)).not.toContain("run");
});

test("buildChecks still surfaces packages as a runnable, individually-named check", () => {
  const checks = buildChecks(
    REAL_CHECKS_DIR,
    path.resolve(REAL_CHECKS_DIR, "..", ".."),
  );
  expect(checks.map((check) => check.name)).toContain("packages");
});
