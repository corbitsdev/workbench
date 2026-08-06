import { expect, test } from "bun:test";
import { auditProductTenancy } from "../no-product-tenancy";

test("clean files pass with no violations", () => {
  const report = auditProductTenancy([
    {
      relPath: "packages/onboarding/src/provision.ts",
      contents: "export const x = 1;",
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("a pgTable(...) call is a violation naming the file, for any table name", () => {
  for (const table of ["tenant", "membership", "invite", "widget"]) {
    const report = auditProductTenancy([
      {
        relPath: `apps/hub/src/${table}.ts`,
        contents: `export const t = pgTable("${table}", {});`,
      },
    ]);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toContain(`apps/hub/src/${table}.ts`);
    expect(report.violations[0]).toContain("pgTable");
  }
});

test("a comment or string that merely mentions a table name is not a violation", () => {
  const report = auditProductTenancy([
    {
      relPath: "packages/onboarding/src/provision.ts",
      contents:
        "// Tenants, memberships, and invites are native Interchange tables.",
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("reports every violation across multiple files, not just the first", () => {
  const report = auditProductTenancy([
    { relPath: "a.ts", contents: `pgTable("role", {})` },
    { relPath: "b.ts", contents: `pgTable("widget", {})` },
    { relPath: "c.ts", contents: "clean" },
  ]);
  expect(report.violations).toHaveLength(2);
});
