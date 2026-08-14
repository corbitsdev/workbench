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

test("allowlisted product schema files pass at their max count", () => {
  const report = auditProductTenancy([
    {
      relPath: "packages/chat/src/schema.ts",
      contents: [
        `export const a = pgTable("channel_settings", {});`,
        `export const bench = pgTable("chat_bench_settings", {});`,
        `export const b = pgTable("channel_read_state", {});`,
        `export const c = pgTable("channel_launch", {});`,
        `export const d = pgTable("channel_tenancy", {});`,
      ].join("\n"),
    },
    {
      relPath: "packages/routines/src/schema.ts",
      contents: [
        `export const routine = pgTable("routine", {});`,
        `export const routineRun = pgTable("routine_run", {});`,
      ].join("\n"),
    },
    {
      relPath: "packages/webhook-triggers/src/schema.ts",
      contents: `export const webhookTrigger = pgTable("webhook_trigger", {});`,
    },
    {
      relPath: "packages/notify/src/schema.ts",
      contents: `export const notifyDispatch = pgTable("notify_dispatch", {});`,
    },
  ]);
  expect(report.violations).toEqual([]);
  expect(
    report.notes.some((n) => n.includes("packages/chat/src/schema.ts")),
  ).toBe(true);
});

test("allowlisted files fail when they grow past their max", () => {
  const report = auditProductTenancy([
    {
      relPath: "packages/routines/src/schema.ts",
      contents: [
        `export const routine = pgTable("routine", {});`,
        `export const routineRun = pgTable("routine_run", {});`,
        `export const routineDraft = pgTable("routine_draft", {});`,
        `export const extra = pgTable("routine_extra", {});`,
      ].join("\n"),
    },
  ]);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("packages/routines/src/schema.ts");
  expect(report.violations[0]).toContain("4 pgTable");
});
