import { authorize, evaluateGrants } from "@intx/authz";
import type { GrantStore } from "@intx/authz";
import type { GrantRule } from "@intx/types/authz";
import { schema as intxSchema } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { and, eq } from "drizzle-orm";
import {
  CAPABILITY_ACTION,
  capabilityResource,
  OAUTH_PROVIDER_CATALOG,
  type OwnerCapabilityState,
} from "@workbench/shared";
import type { HubDb } from "../db";
import { loadMemberRoleGrantsForTenantChain } from "./workflow-run-gate";

const { role, grant } = intxSchema;

// The capability gate mirrors the CL-2885 workflow-run gate exactly, only the
// resource/action vocabulary differs: it is ALLOW-BY-DEFAULT (a connectable
// provider is available to every member unless the owner writes an explicit
// `deny` on the tenant's system `member` role). Pure over the passed grants
// through the REAL @intx/authz matcher so deny-beats-allow + glob semantics stay
// correct.
export async function capabilityDenied(
  memberRoleGrants: GrantRule[],
  provider: string,
): Promise<boolean> {
  const result = await evaluateGrants(
    memberRoleGrants,
    capabilityResource(provider),
    CAPABILITY_ACTION,
  );
  return result.effect === "deny";
}

// Resolves the tenant policy (and ancestors') from the DB and applies
// `capabilityDenied`. A deny set on a parent tenant hides the capability for
// descendants too.
export async function isCapabilityDeniedForTenant(
  db: HubDb,
  tenantChain: readonly string[],
  provider: string,
): Promise<boolean> {
  const grants = await loadMemberRoleGrantsForTenantChain(db, tenantChain);
  return capabilityDenied(grants, provider);
}

// Per-(principal, provider) capability authorization (CL-3356). This is the
// grant check that authorizes a principal acting-as / addressing a SPECIFIC
// principal's connected account — NOT a tenant-wide switch. It collects the
// principal's full grant set (direct + role, via the native `collectGrants`)
// and evaluates `capability:<provider>`/`use`. Allow-by-default, consistent with
// the owner gate: authorized unless an explicit `deny` matches (a per-principal
// deny, or the owner's tenant-wide member-role deny — the latter is included in
// the collected set, so the owner ceiling still applies). Deny wins at equal
// specificity, so a member-role deny cannot be undone by a same-resource
// per-principal allow; scope owner-hides at the level you intend them.
//
// This is the point the inbox/send path must gate on to close the acting-as
// authorization gap (today only tenant domain-match is checked in
// `principal-mailbox.ts`); wiring it into that path is the follow-up resolver
// ticket's integration, layered on this check.
export async function isCapabilityAllowedForPrincipal(
  grantStore: GrantStore,
  tenantId: string,
  principalId: string,
  provider: string,
): Promise<boolean> {
  const result = await authorize(
    grantStore,
    principalId,
    tenantId,
    capabilityResource(provider),
    CAPABILITY_ACTION,
  );
  return result.effect !== "deny";
}

async function lockMemberRoleRow(
  tx: Parameters<Parameters<HubDb["transaction"]>[0]>[0],
  roleId: string,
): Promise<void> {
  await tx
    .select({ id: role.id })
    .from(role)
    .where(eq(role.id, roleId))
    .for("update");
}

// Set a connectable provider's capability enablement for a tenant as a durable
// grant on its system `member` role: `enabled` writes an `allow` (or leaves the
// allow-by-default absence intact) and `disabled` writes a `deny`. Enabled is a
// persisted `allow` row (not the mere absence of a deny) so the three states
// stay distinct — `deny` = owner-hidden, `allow` = owner-enabled, no row =
// never decided (still available). Runs under a member-role row lock, replacing
// any prior capability grant for the provider with exactly one row.
export async function setCapabilityGrant(
  db: HubDb,
  args: {
    tenantId: string;
    roleId: string;
    provider: string;
    enabled: boolean;
  },
): Promise<void> {
  const resource = capabilityResource(args.provider);
  const effect = args.enabled ? "allow" : "deny";
  await db.transaction(async (tx) => {
    await lockMemberRoleRow(tx, args.roleId);
    await tx
      .delete(grant)
      .where(
        and(
          eq(grant.roleId, args.roleId),
          eq(grant.resource, resource),
          eq(grant.action, CAPABILITY_ACTION),
        ),
      );
    const now = new Date();
    await tx.insert(grant).values({
      id: generateId("grant"),
      tenantId: args.tenantId,
      roleId: args.roleId,
      resource,
      action: CAPABILITY_ACTION,
      effect,
      origin: "system",
      createdAt: now,
      updatedAt: now,
    });
  });
}

// The full connectable-provider catalog projected against a tenant's member-role
// policy: each provider with its effective owner-gate state (`enabled` = not
// denied). This is what the owner Capabilities surface renders.
export async function listOwnerCapabilityStates(
  db: HubDb,
  tenantChain: readonly string[],
): Promise<OwnerCapabilityState[]> {
  const grants = await loadMemberRoleGrantsForTenantChain(db, tenantChain);
  const states: OwnerCapabilityState[] = [];
  for (const provider of OAUTH_PROVIDER_CATALOG) {
    const denied = await capabilityDenied(grants, provider.providerName);
    states.push({
      provider: provider.providerName,
      label: provider.label,
      enabled: !denied,
    });
  }
  return states;
}
