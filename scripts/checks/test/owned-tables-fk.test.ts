import { expect, test } from "bun:test";
import { auditOwnedTablesFk } from "../owned-tables-fk";

test("a schema-scoped table with FK'd tenant_id/principal_id passes clean", () => {
  const report = auditOwnedTablesFk([
    {
      relPath: "packages/notify/src/schema.ts",
      contents: `
        const hostTenant = pgTable("tenant", { id: text("id").primaryKey() });
        const hostPrincipal = pgTable("principal", { id: text("id").primaryKey() });
        export const notifyDispatch = notifySchema.table("notify_dispatch", {
          id: text("id").primaryKey(),
          tenantId: text("tenant_id").notNull().references(() => hostTenant.id, { onDelete: "cascade" }),
          principalId: text("principal_id").notNull().references(() => hostPrincipal.id, { onDelete: "cascade" }),
        });
      `,
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("a bare pgTable(...) call outside a named schema is a violation", () => {
  const report = auditOwnedTablesFk([
    {
      relPath: "packages/widget/src/schema.ts",
      contents: `
        export const widget = pgTable("widget", {
          id: text("id").primaryKey(),
          tenantId: text("tenant_id").notNull().references(() => hostTenant.id, { onDelete: "cascade" }),
        });
      `,
    },
  ]);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("pgTable");
  expect(report.violations[0]).toContain("widget");
});

test("a tenant_id/principal_id column with no .references() is a violation", () => {
  const report = auditOwnedTablesFk([
    {
      relPath: "packages/widget/src/schema.ts",
      contents: `
        export const widget = widgetSchema.table("widget", {
          id: text("id").primaryKey(),
          tenantId: text("tenant_id").notNull(),
          principalId: text("principal_id").notNull(),
        });
      `,
    },
  ]);
  expect(report.violations).toHaveLength(2);
  expect(report.violations.some((v) => v.includes("tenant_id"))).toBe(true);
  expect(report.violations.some((v) => v.includes("principal_id"))).toBe(true);
});

test("the tenant/principal host stub tables are exempt from both rules", () => {
  const report = auditOwnedTablesFk([
    {
      relPath: "packages/widget/src/schema.ts",
      contents: `
        const hostTenant = pgTable("tenant", { id: text("id").primaryKey() });
        const hostPrincipal = pgTable("principal", { id: text("id").primaryKey() });
      `,
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("packages/chat/src/schema.ts is skipped as tracked FK debt", () => {
  const report = auditOwnedTablesFk([
    {
      relPath: "packages/chat/src/schema.ts",
      contents: `
        export const t = chatSchema.table("workbench_settings", {
          tenantId: text("tenant_id").notNull(),
        });
      `,
    },
  ]);
  expect(report.violations).toEqual([]);
  expect(report.notes.some((n) => n.includes("packages/chat/src/schema.ts"))).toBe(true);
});

test("a column merely named tenant_id in an unrelated file with no table call is ignored", () => {
  const report = auditOwnedTablesFk([
    {
      relPath: "packages/widget/src/queries.ts",
      contents: `const tenantId = row.tenant_id;`,
    },
  ]);
  expect(report.violations).toEqual([]);
});
