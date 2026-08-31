import { expect, test } from "bun:test";
import { auditDbGate } from "../db-gate";

test("a hand-rolled describeIfDb ternary is a violation naming the file", () => {
  const report = auditDbGate([
    {
      relPath: "packages/example/test/store.test.ts",
      contents:
        'const databaseUrl = process.env["DATABASE_URL"] ?? "";\n' +
        'const describeIfDb = databaseUrl === "" ? describe.skip : describe;\n',
    },
  ]);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("packages/example/test/store.test.ts");
  expect(report.violations[0]).toContain("dbGate");
});

test("the undefined-check variant of the ternary is also a violation", () => {
  const report = auditDbGate([
    {
      relPath: "packages/example/test/migrations.test.ts",
      contents:
        "const databaseUrl = e2eDatabaseUrl();\n" +
        "const describeIfDb = databaseUrl === undefined ? describe.skip : describe;\n",
    },
  ]);
  expect(report.violations).toHaveLength(1);
});

test("a file already routed through dbGate passes", () => {
  const report = auditDbGate([
    {
      relPath: "packages/example/test/store.test.ts",
      contents:
        "const databaseUrl = e2eDatabaseUrl();\n" +
        "const describeIfDb = dbGate(databaseUrl, import.meta.path);\n",
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("a file with no DB gate at all passes", () => {
  const report = auditDbGate([
    {
      relPath: "packages/example/test/pure-unit.test.ts",
      contents: 'test("adds", () => {});\n',
    },
  ]);
  expect(report.violations).toEqual([]);
});
