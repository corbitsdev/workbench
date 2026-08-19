// The security property of CL-6289's simpler memory design: memory scopes
// to the bench/account tenant, resolved by walking the tenant ancestor
// chain up from whatever tenant the request arrived on. DB-gated (skipped
// when DATABASE_URL is unreachable), matching this repo's existing
// convention for tests that talk to a real Postgres (see
// `apps/hub/src/memory-mount.test.ts`) — the tenant hierarchy itself is
// what's under test, so a fake in-memory tenant table would prove nothing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDB, runMigrations, dropSchema, schema } from "@intx/db";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import {
  OperatorTenantHasNoAccountScopeError,
  resolveAccountTenantId,
} from "./account-tenant";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const SCHEMA = "memory_hub_account_tenant_test";

describeIfDb("resolveAccountTenantId", () => {
  const target = dbTargetFromUrl(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );

  beforeAll(async () => {
    await runMigrations(target, { schema: SCHEMA });
  });

  afterAll(async () => {
    await dropSchema(target, { schema: SCHEMA });
  });

  test("a caller in a workbench and the same caller in the bench itself resolve to the SAME scope (operator configured)", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const operatorTenantId = "tnt_op_same_scope";
      const benchTenantId = "tnt_bench_same_scope";
      const workbenchTenantId = "tnt_workbench_same_scope";
      // Sequential inserts, parent before child: the self-referencing
      // `parentId` FK is checked per row as it's inserted.
      await db.insert(schema.tenant).values({
        id: operatorTenantId,
        name: "Operator",
        slug: "op-same-scope",
        domain: "op-same-scope.workbench.test",
      });
      await db.insert(schema.tenant).values({
        id: benchTenantId,
        name: "Acme Bench",
        slug: "acme-bench-same-scope",
        domain: "acme-bench-same-scope.workbench.test",
        parentId: operatorTenantId,
      });
      await db.insert(schema.tenant).values({
        id: workbenchTenantId,
        name: "Acme Workbench",
        slug: "acme-workbench-same-scope",
        domain: "acme-workbench-same-scope.workbench.test",
        parentId: benchTenantId,
      });

      const fromWorkbench = await resolveAccountTenantId({
        db,
        tenantId: workbenchTenantId,
        operatorTenantId,
      });
      const fromBench = await resolveAccountTenantId({
        db,
        tenantId: benchTenantId,
        operatorTenantId,
      });

      expect(fromWorkbench).toBe(benchTenantId);
      expect(fromBench).toBe(benchTenantId);
    } finally {
      await close();
    }
  });

  test("two different accounts under the same operator NEVER resolve to the same scope", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const operatorTenantId = "tnt_op_cross_account";
      const benchATenantId = "tnt_bench_a_cross_account";
      const benchBTenantId = "tnt_bench_b_cross_account";
      const workbenchATenantId = "tnt_workbench_a_cross_account";
      const workbenchBTenantId = "tnt_workbench_b_cross_account";
      await db.insert(schema.tenant).values({
        id: operatorTenantId,
        name: "Operator",
        slug: "op-cross-account",
        domain: "op-cross-account.workbench.test",
      });
      await db.insert(schema.tenant).values({
        id: benchATenantId,
        name: "Account A Bench",
        slug: "bench-a-cross-account",
        domain: "bench-a-cross-account.workbench.test",
        parentId: operatorTenantId,
      });
      await db.insert(schema.tenant).values({
        id: benchBTenantId,
        name: "Account B Bench",
        slug: "bench-b-cross-account",
        domain: "bench-b-cross-account.workbench.test",
        parentId: operatorTenantId,
      });
      await db.insert(schema.tenant).values({
        id: workbenchATenantId,
        name: "Account A Workbench",
        slug: "workbench-a-cross-account",
        domain: "workbench-a-cross-account.workbench.test",
        parentId: benchATenantId,
      });
      await db.insert(schema.tenant).values({
        id: workbenchBTenantId,
        name: "Account B Workbench",
        slug: "workbench-b-cross-account",
        domain: "workbench-b-cross-account.workbench.test",
        parentId: benchBTenantId,
      });

      const scopeA = await resolveAccountTenantId({
        db,
        tenantId: workbenchATenantId,
        operatorTenantId,
      });
      const scopeB = await resolveAccountTenantId({
        db,
        tenantId: workbenchBTenantId,
        operatorTenantId,
      });

      expect(scopeA).toBe(benchATenantId);
      expect(scopeB).toBe(benchBTenantId);
      expect(scopeA).not.toBe(scopeB);
    } finally {
      await close();
    }
  });

  test("the walk never ascends into the operator tenant — stops one hop below it", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const operatorTenantId = "tnt_op_stopping_rule";
      const benchTenantId = "tnt_bench_stopping_rule";
      await db.insert(schema.tenant).values({
        id: operatorTenantId,
        name: "Operator",
        slug: "op-stopping-rule",
        domain: "op-stopping-rule.workbench.test",
      });
      await db.insert(schema.tenant).values({
        id: benchTenantId,
        name: "Bench",
        slug: "bench-stopping-rule",
        domain: "bench-stopping-rule.workbench.test",
        parentId: operatorTenantId,
      });

      const scope = await resolveAccountTenantId({
        db,
        tenantId: benchTenantId,
        operatorTenantId,
      });
      expect(scope).toBe(benchTenantId);
      expect(scope).not.toBe(operatorTenantId);
    } finally {
      await close();
    }
  });

  test("no operator tenant configured: a root bench resolves to itself", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const benchTenantId = "tnt_bench_no_operator";
      const workbenchTenantId = "tnt_workbench_no_operator";
      await db.insert(schema.tenant).values({
        id: benchTenantId,
        name: "Bench",
        slug: "bench-no-operator",
        domain: "bench-no-operator.workbench.test",
      });
      await db.insert(schema.tenant).values({
        id: workbenchTenantId,
        name: "Workbench",
        slug: "workbench-no-operator",
        domain: "workbench-no-operator.workbench.test",
        parentId: benchTenantId,
      });

      const fromWorkbench = await resolveAccountTenantId({
        db,
        tenantId: workbenchTenantId,
      });
      const fromBench = await resolveAccountTenantId({
        db,
        tenantId: benchTenantId,
      });

      expect(fromWorkbench).toBe(benchTenantId);
      expect(fromBench).toBe(benchTenantId);
    } finally {
      await close();
    }
  });

  test("a bench minted before OPERATOR_TENANT_ID was set (operator absent from its chain) still resolves to itself, not the configured operator's tree", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      // This operator tenant exists in the deployment, but this bench was
      // never parented under it — a deployment configuring OPERATOR_TENANT_ID
      // after some benches already exist. Configuring it later must never
      // silently repoint an existing account at a different memory store.
      const operatorTenantId = "tnt_op_configured_later";
      const legacyBenchTenantId = "tnt_bench_predates_operator";
      await db.insert(schema.tenant).values([
        {
          id: operatorTenantId,
          name: "Operator",
          slug: "op-configured-later",
          domain: "op-configured-later.workbench.test",
        },
        {
          id: legacyBenchTenantId,
          name: "Legacy Bench",
          slug: "bench-predates-operator",
          domain: "bench-predates-operator.workbench.test",
          // No parentId: this bench predates the operator tenant.
        },
      ]);

      const scope = await resolveAccountTenantId({
        db,
        tenantId: legacyBenchTenantId,
        operatorTenantId,
      });
      expect(scope).toBe(legacyBenchTenantId);
    } finally {
      await close();
    }
  });

  test("a caller whose own tenant IS the operator tenant fails closed — there is no account beneath it", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const operatorTenantId = "tnt_op_is_caller";
      await db.insert(schema.tenant).values({
        id: operatorTenantId,
        name: "Operator",
        slug: "op-is-caller",
        domain: "op-is-caller.workbench.test",
      });

      await expect(
        resolveAccountTenantId({
          db,
          tenantId: operatorTenantId,
          operatorTenantId,
        }),
      ).rejects.toBeInstanceOf(OperatorTenantHasNoAccountScopeError);
    } finally {
      await close();
    }
  });
});
