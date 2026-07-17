import { and, eq } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import type { GrantStore } from "@intx/types/authz";
import type { SidecarRouter } from "@intx/hub-sessions";
import { getLogger } from "@intx/log";
import { schema, type HubDb } from "../db";
import {
  lookupMember,
  provisionMemberInstances,
  getMyraInstanceId,
} from "../lib/tenant-provisioning";
import { refreshInstanceGrantsFromDefinition } from "./grant-reconcile";

const log = getLogger(["api"]);
const meLog = getLogger(["api", "v1-me"]);

export type SyncPersonalAgentDeps = {
  db: HubDb;
  rootTenantId: string;
  grantStore: GrantStore;
  sidecarRouter: SidecarRouter;
};

export type SyncPersonalAgentOutcome = {
  workingTenantId: string | null;
  memberPrincipalId: string | null;
  paInstanceId: string | null;
  provisionedMyra: boolean;
  grantsRefreshed: boolean;
  grantsPushedLive: boolean;
};

export async function myraInstanceIdForMember(
  db: HubDb,
  workingTenantId: string,
  memberPrincipalId: string,
): Promise<string | null> {
  const { memberAgentInstance } = schema;
  const mapping = await db.query.memberAgentInstance.findFirst({
    where: and(
      eq(memberAgentInstance.tenantId, workingTenantId),
      eq(memberAgentInstance.memberPrincipalId, memberPrincipalId),
      eq(memberAgentInstance.templateKey, "myra"),
    ),
  });
  return mapping?.instanceId ?? null;
}

export type SyncPersonalAgentOptions = {
  // Grant reconcile writes to the DB and pushes live to a routable sidecar, so
  // callers that run on every page load opt out: the drift-gated sync path and
  // the reconcile at session open already cover any instance a user opens.
  reconcileGrants: boolean;
};

// Ensure the caller's global member, principal, Myra instance ROW, and tool
// grants exist and are reconciled. This does NOT launch a Myra session — the
// primary chat thread and the bottom-right popup both launch-on-demand: every
// Myra surface (`useMyraSession`) calls `POST /v1/instances/:id/sessions` before
// opening its stream, which cold-(re)launches a never-launched OR reaper-slept
// instance (CL-2793). When reconcile is on, grants are persisted here and pushed
// live only when the instance already happens to be routable; a cold instance
// picks them up at its lazy launch.
export async function syncPersonalAgentForUser(
  deps: SyncPersonalAgentDeps,
  userId: string,
  options?: SyncPersonalAgentOptions,
): Promise<SyncPersonalAgentOutcome> {
  const { db, rootTenantId, grantStore, sidecarRouter } = deps;
  const reconcileGrants = options?.reconcileGrants ?? true;

  const membership = await lookupMember(db, {
    tenantId: rootTenantId,
    userId,
  });
  const workingTenantId = membership?.tenantId ?? null;
  const memberPrincipalId = membership?.principalId ?? null;
  if (!workingTenantId || !memberPrincipalId) {
    return {
      workingTenantId: null,
      memberPrincipalId: null,
      paInstanceId: null,
      provisionedMyra: false,
      grantsRefreshed: false,
      grantsPushedLive: false,
    };
  }

  let paInstanceId: string | null = null;
  let provisionedMyra = false;
  let grantsRefreshed = false;
  let grantsPushedLive = false;
  if (workingTenantId && memberPrincipalId) {
    paInstanceId = await myraInstanceIdForMember(
      db,
      workingTenantId,
      memberPrincipalId,
    );

    if (!paInstanceId) {
      try {
        const instances = await provisionMemberInstances(db, {
          tenantId: rootTenantId,
          userId,
          memberPrincipalId,
        });
        paInstanceId = getMyraInstanceId(instances);
        provisionedMyra = paInstanceId !== null;
        if (provisionedMyra) {
          meLog.info("Provisioned Myra instance on POST /v1/me", {
            userId,
            instanceId: paInstanceId,
          });
        }
      } catch (err) {
        log.warn("Failed to re-provision Myra on POST /v1/me", {
          userId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    if (paInstanceId && reconcileGrants) {
      try {
        const paForGrants = await db.query.agentInstance.findFirst({
          where: eq(intxSchema.agentInstance.id, paInstanceId),
        });
        if (paForGrants) {
          const routable = sidecarRouter
            .getRoutableAddresses()
            .includes(paForGrants.address);
          const grantResult = await refreshInstanceGrantsFromDefinition(
            db,
            {
              agentId: paForGrants.agentId,
              tenantId: paForGrants.tenantId,
              principalId: paForGrants.principalId,
              address: paForGrants.address,
              instanceId: paInstanceId,
            },
            routable ? { sidecarRouter, grantStore } : undefined,
          );
          grantsRefreshed = grantResult.refreshed;
          grantsPushedLive = grantResult.pushed;
          if (grantResult.refreshed) {
            meLog.info("Myra grant reconcile on POST /v1/me", {
              userId,
              instanceId: paInstanceId,
              address: paForGrants.address,
              pushedLive: grantResult.pushed,
              routable,
            });
          }
        }
      } catch (err) {
        log.warn("Failed to refresh live Myra grants on POST /v1/me", {
          userId,
          instanceId: paInstanceId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
  }

  return {
    workingTenantId,
    memberPrincipalId,
    paInstanceId,
    provisionedMyra,
    grantsRefreshed,
    grantsPushedLive,
  };
}
