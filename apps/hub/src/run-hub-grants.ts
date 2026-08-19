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

export function createRunHubGrantPlane(
  deps: RunHubGrantPlaneDeps,
): RunHubGrantPlane {
  return {
    async mint(params) {
      const {
        runTenantId,
        runPrincipalId,
        invokerPrincipalId,
        toolPackagePins,
        tx,
      } = params;
      const requirements = deps.requirementsForPins(toolPackagePins);
      if (requirements.length === 0) return;

      const orgTenantId = await orgTenantIdFor(deps, runTenantId);
      if (orgTenantId === null) return;

      // The invoker's principal is scoped to whatever tenancy they launched
      // from; their authority lives on their principal in the org tenant.
      const invokerUserRefId = await resolveUserRefIdForPrincipal(
        deps.db,
        invokerPrincipalId,
      );
      if (invokerUserRefId === null) {
        log.warn(
          `run grants: invoker ${invokerPrincipalId} is not a person's principal — run ${runPrincipalId} gets no hub-side authority`,
        );
        return;
      }

      const invokerOrgPrincipalId = await resolveOrgPrincipalId(
        deps.db,
        orgTenantId,
        invokerUserRefId,
      );
      if (invokerOrgPrincipalId === null) {
        log.info(
          `run grants: invoker holds no principal in org tenant ${orgTenantId} — run ${runPrincipalId} launches with no hub-side authority and its tools fail closed`,
        );
        return;
      }

      const invokerGrants = await deps.grantStore.collectGrantsInChain(
        invokerOrgPrincipalId,
        orgTenantId,
      );
      // Invoker-sourced grants cannot be transitively re-delegated, matching
      // upstream's own `resolveGrantMaterialization`.
      const delegatable = invokerGrants.filter((g) => g.origin !== "invoker");

      const now = new Date();
      const rows = [];
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
          origin: "invoker" as const,
          // No expiry. A workbench host or invited agent is woken
          // indefinitely and its invoker is gone by the first wake, so a
          // time-boxed row would silently strip its memory with no path to
          // renewal. Revoked explicitly on a failed launch instead.
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
      if (rows.length === 0) return;
      await tx.insert(grant).values(rows);
    },

    async revoke(params) {
      const { runPrincipalId } = params;
      await deps.db
        .delete(grant)
        .where(
          and(eq(grant.principalId, runPrincipalId), eq(grant.origin, "invoker")),
        );
    },
  };
}
