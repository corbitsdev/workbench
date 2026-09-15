// CL-7324: hermetic tests for the Workbench-side dispatch containment
// (`dispatch-tenant-guard.ts`). No database: the service wrapper gets a
// stub anchor-tenant resolver and a stub delegate, and the route guard
// gets a stub tenancy loader in front of a counting inner app — proving
// the decision logic itself, not Postgres.
import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@intx/hub-api";
import type { SidecarAllocation } from "@intx/db";
import type { WorkflowAllocationService } from "@intx/hub-sessions";

import {
  ALLOCATION_TENANT_MISMATCH_CODE,
  AllocationTenantMismatchError,
  TENANT_MISMATCH_FAILURE_CODE,
  withDispatchTenantGuard,
  withTenantBoundAllocationService,
} from "./dispatch-tenant-guard";

function allocationFor(args: {
  id?: string;
  anchorRunId?: string;
  tenantId?: string;
}): SidecarAllocation {
  return {
    id: args.id ?? "sal_test",
    anchorRunId: args.anchorRunId ?? "wfr_anchor",
    tenantId: args.tenantId ?? "ten_a",
    provisionerId: "process",
    provisionerApiVersion: 1,
    provisionerBindingFingerprint: "fp",
    status: "allocated",
    generation: 1,
    ensureAttempts: 0,
    destroyAttempts: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function stubAllocationService(): WorkflowAllocationService & {
  deployCalls: SidecarAllocation[];
} {
  const deployCalls: SidecarAllocation[] = [];
  const service = {
    deployCalls,
    async prepareProvisionedDeployment() {
      throw new Error("not implemented in stub");
    },
    async deployReadyAllocation(allocation: SidecarAllocation) {
      deployCalls.push(allocation);
      return null;
    },
  } as unknown as WorkflowAllocationService & {
    deployCalls: SidecarAllocation[];
  };
  return service;
}

test("deployReadyAllocation delegates when allocation and anchor tenants match", async () => {
  const inner = stubAllocationService();
  const guarded = withTenantBoundAllocationService(inner, {
    resolveAnchorTenantId: async () => "ten_a",
  });
  const allocation = allocationFor({ tenantId: "ten_a" });
  const result = await guarded.deployReadyAllocation(allocation);
  expect(result).toBeNull();
  expect(inner.deployCalls).toEqual([allocation]);
});

test("deployReadyAllocation throws tenant_mismatch without delegating on a foreign allocation", async () => {
  const inner = stubAllocationService();
  const guarded = withTenantBoundAllocationService(inner, {
    resolveAnchorTenantId: async () => "ten_a",
  });
  const thrown = await guarded
    .deployReadyAllocation(allocationFor({ tenantId: "ten_b" }))
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(thrown).toBeInstanceOf(AllocationTenantMismatchError);
  expect((thrown as AllocationTenantMismatchError).code).toBe(
    TENANT_MISMATCH_FAILURE_CODE,
  );
  // Never falls through to another tenant: the delegate never ran, so the
  // allocation can never deploy — the reconciler retries instead.
  expect(inner.deployCalls).toEqual([]);
});

test("deployReadyAllocation fails closed when the anchor row is gone", async () => {
  const inner = stubAllocationService();
  const guarded = withTenantBoundAllocationService(inner, {
    resolveAnchorTenantId: async () => undefined,
  });
  const thrown = await guarded
    .deployReadyAllocation(allocationFor({ tenantId: "ten_a" }))
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(thrown).toBeInstanceOf(AllocationTenantMismatchError);
  expect(inner.deployCalls).toEqual([]);
});

function guardedTestApp(
  loadAnchorDispatch: (
    anchorRunId: string,
  ) => Promise<
    | { anchorTenantId: string; allocationTenantIds: readonly string[] }
    | undefined
  >,
): { app: Hono<AppEnv>; state: { innerHits: number } } {
  const state = { innerHits: 0 };
  const inner = new Hono<AppEnv>();
  inner.all("*", (c) => {
    state.innerHits += 1;
    return c.json({ reached: true }, 200);
  });
  const app = withDispatchTenantGuard(inner, { loadAnchorDispatch });
  return { app, state };
}

async function postApp(
  app: Hono<AppEnv>,
  path: string,
): Promise<{ status: number; body: unknown; app: Hono<AppEnv> }> {
  const res = await app.request(path, { method: "POST" });
  return { status: res.status, body: await res.json(), app };
}

test("mail trigger with a foreign allocation answers 403 allocation_tenant_mismatch without reaching the inner app", async () => {
  const { app, state } = guardedTestApp(async () => ({
    anchorTenantId: "ten_a",
    allocationTenantIds: ["ten_b"],
  }));
  const { status, body } = await postApp(
    app,
    "/api/tenants/ten_a/workflows/wfr_anchor/mail",
  );
  expect(status).toBe(403);
  expect(body).toMatchObject({
    error: expect.objectContaining({ code: ALLOCATION_TENANT_MISMATCH_CODE }),
  });
  expect(state.innerHits).toBe(0);
});

test("signals route with a foreign allocation answers 403 without reaching the inner app", async () => {
  const { app, state } = guardedTestApp(async () => ({
    anchorTenantId: "ten_a",
    allocationTenantIds: ["ten_a", "ten_b"],
  }));
  const { status } = await postApp(
    app,
    "/api/tenants/ten_a/workflows/wfr_anchor/signals",
  );
  expect(status).toBe(403);
  expect(state.innerHits).toBe(0);
});

test("matching anchor and allocation tenants fall through to the inner app", async () => {
  const { app, state } = guardedTestApp(async () => ({
    anchorTenantId: "ten_a",
    allocationTenantIds: ["ten_a"],
  }));
  const { status } = await postApp(
    app,
    "/api/tenants/ten_a/workflows/wfr_anchor/mail",
  );
  expect(status).toBe(200);
  expect(state.innerHits).toBe(1);
});

test("a pre-provisioning anchor with no allocation rows falls through", async () => {
  const { app, state } = guardedTestApp(async () => ({
    anchorTenantId: "ten_a",
    allocationTenantIds: [],
  }));
  const { status } = await postApp(
    app,
    "/api/tenants/ten_a/workflows/wfr_anchor/signals",
  );
  expect(status).toBe(200);
  expect(state.innerHits).toBe(1);
});

test("an absent anchor falls through so the native lookup owns the 404", async () => {
  const { app, state } = guardedTestApp(async () => undefined);
  const { status } = await postApp(
    app,
    "/api/tenants/ten_a/workflows/wfr_missing/mail",
  );
  expect(status).toBe(200);
  expect(state.innerHits).toBe(1);
});

test("an anchor owned by another tenant falls through so the native lookup owns the 404", async () => {
  const { app, state } = guardedTestApp(async () => ({
    anchorTenantId: "ten_other",
    allocationTenantIds: ["ten_other"],
  }));
  const { status } = await postApp(
    app,
    "/api/tenants/ten_a/workflows/wfr_anchor/mail",
  );
  expect(status).toBe(200);
  expect(state.innerHits).toBe(1);
});

test("non-dispatch paths are never intercepted", async () => {
  const { app, state } = guardedTestApp(async () => ({
    anchorTenantId: "ten_a",
    allocationTenantIds: ["ten_b"],
  }));
  const res = await app.request("/api/tenants/ten_a/workflows", {
    method: "GET",
  });
  expect(res.status).toBe(200);
  expect(state.innerHits).toBe(1);
});
