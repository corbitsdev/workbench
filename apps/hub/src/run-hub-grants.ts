// A folded run's hub-side authority, bounded by whoever invoked it —
// `@corbits/folded-runs`' `RunHubGrantPlane` port, implemented here at the
// composition root because computing it needs this hub's own tenant
// hierarchy (`./account-tenant.ts`) and its own tool-package registry
// (`./tool-grants.ts`), neither of which `folded-runs` may import.
//
// The rows land in the ORG tenant, because that is where memory lives and
// where `requireGrant` resolves them from: the DB grant store filters on
// `grant.tenantId`, so a row written in the run's own workbench tenant
// would match nothing when a memory route asks. They are written onto the
// run's own principal, which `./memory-mount.ts`'s caller resolver already
// carries through unchanged for a workflow caller.
//
// An agent that could reach further than the person who started it is
// privilege escalation wearing a tool pin, so the row set is an
// intersection, never a copy: each requirement its pinned packages declare
// is tested against the invoker's own collected grants, and only what
// survives is written. An invoker who holds nothing yields no rows, the run
// still launches, and its memory tools fail closed.
import { authorizeAction } from "@intx/authz";
import type { GrantStore } from "@intx/authz";
import { and, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import type { GrantEffect } from "@intx/types";
import type { ToolPackagePin } from "@intx/types/tool-packages";
import { grant } from "@intx/db/schema";
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import type { RunHubGrantPlane } from "@corbits/folded-runs";

import {
  resolveAccountTenantId,
  OperatorTenantHasNoAccountScopeError,
} from "./account-tenant";
import {
  resolveOrgPrincipalId,
  resolveUserRefIdForPrincipal,
} from "./org-principal";
import type { HubGrantRequirementsForPins } from "./tool-grants";

const log = getLogger(["hub", "run-hub-grants"]);

export type RunHubGrantPlaneDeps = {
  readonly db: DB["db"];
  readonly grantStore: GrantStore;
  readonly requirementsForPins: HubGrantRequirementsForPins;
  /** `config.operatorTenantId` — where the account-tenant walk stops. */
  readonly operatorTenantId?: string;
};

async function orgTenantIdFor(
  deps: RunHubGrantPlaneDeps,
  runTenantId: string,
): Promise<string | null> {
  try {
    return await resolveAccountTenantId({
      db: deps.db,
      tenantId: runTenantId,
      ...(deps.operatorTenantId !== undefined
        ? { operatorTenantId: deps.operatorTenantId }
        : {}),
    });
  } catch (cause) {
    if (cause instanceof OperatorTenantHasNoAccountScopeError) {
      log.warn(
        `run grants: ${cause.message} (tenant ${runTenantId} is the operator tenant) — this run gets no hub-side authority`,
      );
      return null;
    }
    throw cause;
  }
}

type PreparedGrantRow = {
  id: string;
  tenantId: string;
  principalId: string;
  resource: string;
  action: string;
  effect: GrantEffect;
  conditions: null;
  origin: "invoker";
  expiresAt: null;
  createdAt: Date;
  updatedAt: Date;
};

async function resolveRows(
  deps: RunHubGrantPlaneDeps,
  params: {
    readonly runTenantId: string;
    readonly runPrincipalId: string;
    readonly invokerPrincipalId: string;
    readonly toolPackagePins: readonly ToolPackagePin[];
  },
): Promise<readonly PreparedGrantRow[]> {
  const { runTenantId, runPrincipalId, invokerPrincipalId, toolPackagePins } =
    params;
  const requirements = deps.requirementsForPins(toolPackagePins);
  if (requirements.length === 0) return [];

  const orgTenantId = await orgTenantIdFor(deps, runTenantId);
  if (orgTenantId === null) return [];

  // The invoker's principal is scoped to whatever tenancy they launched
  // from; their authority lives on their principal in the org tenant.
  const invokerUserRefId = await resolveUserRefIdForPrincipal(
    deps.db,
    invokerPrincipalId,
  );
  if (invokerUserRefId === null) {
    log.warn(
      `run grants: invoker ${invokerPrincipalId} is not an active person's principal — run ${runPrincipalId} gets no hub-side authority`,
    );
    return [];
  }

  const invokerOrgPrincipalId = await resolveOrgPrincipalId(
    deps.db,
    orgTenantId,
    invokerUserRefId,
  );
  if (invokerOrgPrincipalId === null) {
    log.info(
      `run grants: invoker holds no active principal in org tenant ${orgTenantId} — run ${runPrincipalId} launches with no hub-side authority and its tools fail closed`,
    );
    return [];
  }

  // Single-tenant, never `collectGrantsInChain`. The chain variant unions
  // in every ancestor tenant, and upstream reserves it for the
  // credential-use check alone — "the general RBAC path stays on the
  // single-tenant `collectGrants`" (`@intx/types`' `GrantStore`), which is
  // what `requireGrant` on the memory routes actually evaluates. Collecting
  // wider than the routes honour would let a grant stamped with an ancestor
  // tenant mint the run a row in the org tenant that its invoker cannot use
  // themselves — authority created out of nothing, which is the whole
  // failure this plane exists to prevent.
  const invokerGrants = await deps.grantStore.collectGrants(
    invokerOrgPrincipalId,
    orgTenantId,
  );
  // Invoker-sourced grants cannot be transitively re-delegated, matching
  // upstream's own `resolveGrantMaterialization`.
  const delegatable = invokerGrants.filter((g) => g.origin !== "invoker");

  const now = new Date();
  const rows: PreparedGrantRow[] = [];
  for (const requirement of requirements) {
    const decision = await authorizeAction(
      delegatable,
      requirement.resource,
      requirement.action,
    );
    if (!decision.ok) continue;
    rows.push({
      id: generateId("grant"),
      tenantId: orgTenantId,
      principalId: runPrincipalId,
      resource: requirement.resource,
      action: requirement.action,
      effect: requirement.effect,
      conditions: null,
      origin: "invoker",
      // No expiry, and this is a deliberate trade with two known costs.
      // A workbench host or invited agent is woken indefinitely and its
      // invoker is gone by the first wake, so a time-boxed row would
      // silently strip its memory with no path to renewal — and nothing
      // re-derives authority at wake, so an invoker later removed from the
      // org does not lose the reach of agents they already launched.
      //
      // Rows are revoked on a failed launch and on a one-shot run's
      // teardown. A task, routine, or webhook run that completes normally
      // keeps its rows: the platform deactivates a terminal run's
      // principal rather than deleting it, so the FK cascade never fires.
      // Those rows are inert — an inactive principal is refused a seat —
      // but they do accumulate per run. A periodic sweep over deactivated
      // principals collects them; that sweep is tracked separately and is
      // not part of this plane.
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  if (rows.length < requirements.length) {
    log.info(
      `run grants: run ${runPrincipalId} takes ${rows.length} of ${requirements.length} requested grants — the rest exceed what its invoker holds`,
    );
  }
  return rows;
}

export function createRunHubGrantPlane(
  deps: RunHubGrantPlaneDeps,
): RunHubGrantPlane {
  return {
    async prepare(params) {
      const rows = await resolveRows(deps, params);
      return async (tx) => {
        if (rows.length === 0) return;
        await tx.insert(grant).values([...rows]);
      };
    },

    async revoke(params) {
      const { runPrincipalId } = params;
      await deps.db
        .delete(grant)
        .where(
          and(
            eq(grant.principalId, runPrincipalId),
            eq(grant.origin, "invoker"),
          ),
        );
    },
  };
}
