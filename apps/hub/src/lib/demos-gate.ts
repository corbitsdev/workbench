import { evaluateGrants } from "@intx/authz";
import type { GrantRule } from "@intx/types/authz";
import {
  DEMO_LINKS,
  DEMOS_RESOURCE,
  DEMOS_VIEW_ACTION,
  type DemoLink,
} from "@workbench/shared";
import type { HubDb } from "../db";
import { loadMemberRoleGrantsForTenantChain } from "./workflow-run-gate";

// Demos are HIDDEN by default: only an explicit member-role ALLOW on
// `demos`/`view` opts the org in. Pure over the passed grants through the REAL
// @intx/authz matcher, so glob/specificity semantics stay correct. Absent any
// grant → no match → effect null → not allowed.
export async function demosViewAllowed(
  memberRoleGrants: GrantRule[],
): Promise<boolean> {
  const result = await evaluateGrants(
    memberRoleGrants,
    DEMOS_RESOURCE,
    DEMOS_VIEW_ACTION,
  );
  return result.effect === "allow";
}

// Resolves the org-wide demos grant from the member role of `tenantId` (the same
// scope the owner toggle writes).
export async function isDemosEnabledByGrant(
  db: HubDb,
  tenantId: string,
): Promise<boolean> {
  const grants = await loadMemberRoleGrantsForTenantChain(db, [tenantId]);
  return demosViewAllowed(grants);
}

// The demo links the client should receive. The `SHOW_DEMOS` env flag is a
// global override on top of the org-wide grant; when neither is on the list is
// empty, so the links never leave the hub.
export function resolveDemoLinks(
  showDemosEnv: boolean,
  grantEnabled: boolean,
): DemoLink[] {
  if (showDemosEnv || grantEnabled) return [...DEMO_LINKS];
  return [];
}
