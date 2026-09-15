// [Intx gap] CL-7324: the native dispatch path joins anchor + allocation
// on `anchorRunId` alone — neither
// `vendor/intx/hub-api/src/run-grant-materialization.ts`'s
// `lockDispatchableAllocation` nor the signal route's deployment query
// (`vendor/intx/hub-api/src/routes/workflows.ts`) filters the allocation
// leg by tenant. A sidecar allocation row bound to an anchor but carrying
// another tenant's id would therefore dispatch — and materialize grants —
// cross-tenant. Filed upstream; vendor is read-only, so this hub contains
// at its own seams instead of patching the join:
//
// 1. `withTenantBoundAllocationService` wraps the allocation service this
//    composition root hands to `createApp` (and every Workbench-owned call
//    site): `deployReadyAllocation` throws `AllocationTenantMismatchError`
//    before delegating whenever the allocation's tenant is not the anchor
//    run's tenant. The reconciler's `onReady` catch-all turns any throw
//    into `scheduleRetry` (`sidecar_initialization_failed`), so a mismatch
//    is retryable, never terminal, and never falls through to another
//    tenant — the allocation simply never deploys.
// 2. `withDispatchTenantGuard` outer-wraps the fully-built app (the same
//    composition as `tenant-create-guard.ts`'s `guardedHubApp`) and denies
//    the two dispatch routes — `POST
//    /api/tenants/:tenantId/workflows/:runId/mail` and `POST
//    /api/tenants/:tenantId/workflows/:runId/signals` — with 403
//    `allocation_tenant_mismatch` when an allocation bound to the anchor
//    carries a foreign tenant, before the native handler can enqueue or
//    materialize grants. An absent anchor (or an anchor owned by another
//    tenant) falls through: the native tenant-scoped lookup owns that 404.
//
// Bench-owner, hub-provisioned, tenant-bound dispatch only (operator
// ruling 2026-09-15, Option A). No enrollment or allowlist surfaces live
// here — those were deferred (B/C), so there is nothing to consult: any
// cross-tenant join is denied, not admitted.
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { DB } from "@intx/db";
import { sidecarAllocation, workflowRun } from "@intx/db/schema";
import type { AppEnv } from "@intx/hub-api";
import type { SidecarAllocation } from "@intx/db";
import type { WorkflowAllocationService } from "@intx/hub-sessions";
import { makeErrorEnvelope, reportError } from "@corbits/error-sink";

/** Error-code surfaced at the route seam on a foreign-tenant allocation. */
export const ALLOCATION_TENANT_MISMATCH_CODE = "allocation_tenant_mismatch";
/** Reconciler failure code a mismatch surfaces as: scheduled for retry,
 * never terminal. */
export const TENANT_MISMATCH_FAILURE_CODE = "tenant_mismatch";

/**
 * Thrown (never returned) when an allocation's tenant is not its anchor
 * run's tenant. Retryable by construction: nothing downstream treats this
 * as terminal, and the throw precedes any delegate call, so a mismatched
 * allocation can never deploy or dispatch into another tenant.
 */
export class AllocationTenantMismatchError extends Error {
  readonly code = TENANT_MISMATCH_FAILURE_CODE;
  readonly anchorRunId: string;
  readonly anchorTenantId: string | undefined;
  readonly allocationId: string | undefined;
  readonly allocationTenantId: string;

  constructor(args: {
    anchorRunId: string;
    anchorTenantId: string | undefined;
    allocationId: string | undefined;
    allocationTenantId: string;
  }) {
    super(
      `allocation ${args.allocationId ?? "<unknown>"} carries tenant ` +
        `${args.allocationTenantId} but anchors run ${args.anchorRunId} of ` +
        `tenant ${args.anchorTenantId ?? "<missing anchor>"}`,
    );
    this.name = "AllocationTenantMismatchError";
    this.anchorRunId = args.anchorRunId;
    this.anchorTenantId = args.anchorTenantId;
    this.allocationId = args.allocationId;
    this.allocationTenantId = args.allocationTenantId;
  }
}

function mismatchContext(error: AllocationTenantMismatchError): {
  operation: string;
  tenantId: string;
  extra: Record<string, string>;
} {
  const extra: Record<string, string> = {
    anchorRunId: error.anchorRunId,
    allocationTenantId: error.allocationTenantId,
  };
  if (error.allocationId !== undefined) {
    extra["allocationId"] = error.allocationId;
  }
  if (error.anchorTenantId !== undefined) {
    extra["anchorTenantId"] = error.anchorTenantId;
  }
  return {
    operation: "workflow-dispatch-tenant-guard",
    tenantId: error.allocationTenantId,
    extra,
  };
}

/** Anchor run's owning tenant — `undefined` when the anchor row is gone. */
export async function resolveAnchorTenantId(
  db: DB["db"],
  anchorRunId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ tenantId: workflowRun.tenantId })
    .from(workflowRun)
    .where(eq(workflowRun.id, anchorRunId))
    .limit(1);
  return row?.tenantId;
}

export type TenantBoundAllocationServiceDeps = {
  /** Anchor run's owning tenant (`undefined` when the row is gone), kept
   * injectable so the wrapper's decision is testable without a database. */
  resolveAnchorTenantId: (anchorRunId: string) => Promise<string | undefined>;
};

/**
 * Wraps the allocation service so `deployReadyAllocation` enforces the
 * anchor/allocation tenant join: on a mismatch (or a missing anchor row)
 * it reports through the error sink and throws
 * `AllocationTenantMismatchError` WITHOUT delegating — the reconciler
 * retries, the allocation never deploys, and dispatch never crosses
 * tenants. Every other method passes straight through.
 */
export function withTenantBoundAllocationService(
  service: WorkflowAllocationService,
  deps: TenantBoundAllocationServiceDeps,
): WorkflowAllocationService {
  return {
    ...service,
    async deployReadyAllocation(allocation: SidecarAllocation) {
      const anchorTenantId = await deps.resolveAnchorTenantId(
        allocation.anchorRunId,
      );
      if (
        anchorTenantId === undefined ||
        anchorTenantId !== allocation.tenantId
      ) {
        const mismatch = new AllocationTenantMismatchError({
          anchorRunId: allocation.anchorRunId,
          anchorTenantId,
          allocationId: allocation.id,
          allocationTenantId: allocation.tenantId,
        });
        reportError(mismatch, mismatchContext(mismatch));
        throw mismatch;
      }
      return service.deployReadyAllocation(allocation);
    },
  };
}

export type AnchorDispatchTenancy = {
  /** Owning tenant of the anchor run named in the URL. */
  readonly anchorTenantId: string;
  /** Tenant of every allocation row bound to that anchor (empty when the
   * deployment has no allocation yet — pre-provisioning deploys). */
  readonly allocationTenantIds: readonly string[];
};

export type DispatchTenantGuardDeps = {
  /** Anchor + bound-allocation tenancy (`undefined` when the anchor row is
   * gone), injected so the guard's decision stays DB-free in tests. */
  loadAnchorDispatch: (
    anchorRunId: string,
  ) => Promise<AnchorDispatchTenancy | undefined>;
};

/** Production read: anchor row plus every allocation row bound to it. */
export async function loadAnchorDispatch(
  db: DB["db"],
  anchorRunId: string,
): Promise<AnchorDispatchTenancy | undefined> {
  const [anchor] = await db
    .select({ tenantId: workflowRun.tenantId })
    .from(workflowRun)
    .where(eq(workflowRun.id, anchorRunId))
    .limit(1);
  if (anchor === undefined) return undefined;
  const rows = await db
    .select({ tenantId: sidecarAllocation.tenantId })
    .from(sidecarAllocation)
    .where(eq(sidecarAllocation.anchorRunId, anchorRunId));
  return {
    anchorTenantId: anchor.tenantId,
    allocationTenantIds: rows.map((row) => row.tenantId),
  };
}

const DISPATCH_GUARD_PATHS = [
  "/api/tenants/:tenantId/workflows/:runId/mail",
  "/api/tenants/:tenantId/workflows/:runId/signals",
] as const;

/**
 * Wraps the fully-built hub app in an outer app that denies the two
 * dispatch routes with 403 `allocation_tenant_mismatch` when any
 * allocation bound to the anchor carries a tenant other than the URL
 * tenant — before the native handler joins anchor+allocation and
 * materializes grants or enqueues. Every other path, an anchor with no
 * foreign allocation, and an absent/foreign anchor (the native
 * tenant-scoped lookup owns that 404) fall straight through.
 */
export function withDispatchTenantGuard(
  nativeApp: Hono<AppEnv>,
  deps: DispatchTenantGuardDeps,
): Hono<AppEnv> {
  const guarded = new Hono<AppEnv>();

  for (const path of DISPATCH_GUARD_PATHS) {
    guarded.use(path, async (c, next) => {
      if (c.req.method !== "POST") return next();
      const tenantId = c.req.param("tenantId");
      const anchorRunId = c.req.param("runId");
      const anchor = await deps.loadAnchorDispatch(anchorRunId);
      if (anchor === undefined || anchor.anchorTenantId !== tenantId) {
        return next();
      }
      const foreign = anchor.allocationTenantIds.find(
        (allocationTenantId) => allocationTenantId !== tenantId,
      );
      if (foreign === undefined) return next();
      const mismatch = new AllocationTenantMismatchError({
        anchorRunId,
        anchorTenantId: anchor.anchorTenantId,
        allocationId: undefined,
        allocationTenantId: foreign,
      });
      reportError(mismatch, mismatchContext(mismatch));
      return c.json(
        makeErrorEnvelope({
          code: ALLOCATION_TENANT_MISMATCH_CODE,
          userMessage:
            "This deployment's allocation belongs to another workbench and cannot be dispatched here.",
        }),
        403,
      );
    });
  }

  guarded.route("/", nativeApp);
  return guarded;
}
