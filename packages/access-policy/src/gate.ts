// Composition over `./policy.ts`'s pure functions and `./store.ts`'s
// persistence: the two entry points `packages/onboarding`'s first-login
// hook calls. Nothing here patches a vendor route — a pending invite
// resolves through the native invite route (`POST
// /tenants/:id/members/invite`) and an immediate status flip to
// "active" (`PATCH /tenants/:id/principals/:id`), the same two native
// primitives `packages/settings-ui` already drives by hand.
import type { ApiCall } from "@workbench/hub-client";

import { evaluateSignupGate, type SignupGateResult } from "./policy";
import type { AccessPolicyStore } from "./store";

export type SignupGateCheckArgs = {
  readonly store: AccessPolicyStore;
  /** The tenant a fresh personal bench would be parented under, if
   * any — the same `operatorTenantId` the onboarding hook already
   * threads into tenant creation. No operator tenant means there is no
   * tenant to hold a policy row, so only the env flag can gate. */
  readonly operatorTenantId?: string;
  readonly envSignupMode: "open" | "closed";
  readonly envAllowedDomains: readonly string[];
  readonly email: string;
};

/**
 * The one signup-gate check the first-login hook calls before minting a
 * personal bench. Looks up whether the operator tenant carries an
 * explicit policy row; if so that row decides outright, otherwise the
 * env flag bootstraps.
 */
export async function checkSignupGate(
  args: SignupGateCheckArgs,
): Promise<SignupGateResult> {
  let policy: Awaited<ReturnType<AccessPolicyStore["getPolicy"]>> | undefined;
  if (args.operatorTenantId !== undefined) {
    const hasRow = await args.store.hasPolicyRow(args.operatorTenantId);
    if (hasRow) policy = await args.store.getPolicy(args.operatorTenantId);
  }
  return evaluateSignupGate({
    policy,
    envSignupMode: args.envSignupMode,
    envAllowedDomains: args.envAllowedDomains,
    email: args.email,
  });
}

export type PendingInviteResolution = {
  readonly tenantId: string;
  readonly principalId: string;
};

/**
 * Resolves a not-yet-registered email against `access_policy`'s pending
 * invites once the user has actually logged in (so a user row now
 * exists — the gap the native invite route can't cross on its own).
 * On a match: invites the now-existing user through the native route,
 * immediately activates the resulting principal (the pending row is
 * this package's record of prior consent, so there is no separate
 * accept step), and consumes an exact-email match. Returns undefined
 * when nothing matches — the caller falls back to its own signup gate.
 */
export async function resolvePendingInviteOnLogin(args: {
  store: AccessPolicyStore;
  api: ApiCall;
  cookies: string[];
  email: string;
}): Promise<PendingInviteResolution | undefined> {
  const match = await args.store.findMatchingPendingInvite(args.email);
  if (match === undefined) return undefined;

  const inviteBody: { email: string; roleId?: string } = {
    email: args.email,
  };
  if (match.roleId !== undefined) inviteBody.roleId = match.roleId;

  const invited = await args.api(
    "POST",
    `/api/tenants/${match.tenantId}/members/invite`,
    inviteBody,
    args.cookies,
  );
  if (invited.status !== 201) {
    throw new Error(
      `pending invite ${match.id} could not be redeemed against tenant ${match.tenantId} (status ${invited.status}): ${JSON.stringify(invited.data)}`,
    );
  }
  const principal = invited.data as { id?: unknown };
  if (typeof principal.id !== "string") {
    throw new Error(
      `pending invite ${match.id} redemption returned no principal id`,
    );
  }
  const principalId = principal.id;

  const activated = await args.api(
    "PATCH",
    `/api/tenants/${match.tenantId}/principals/${principalId}`,
    { status: "active" },
    args.cookies,
  );
  if (activated.status !== 200) {
    throw new Error(
      `pending invite ${match.id} redeemed a principal but activation failed (status ${activated.status}): ${JSON.stringify(activated.data)}`,
    );
  }

  if (match.matchType === "email") {
    await args.store.consumePendingInvite(match.id);
  }

  return { tenantId: match.tenantId, principalId };
}
