// Composition over `./policy.ts`'s pure functions and `./store.ts`'s
// persistence: the signup-gate entry point `packages/onboarding`'s
// first-login hook calls.
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
  readonly emailVerified: boolean;
  readonly allowUnverifiedEmails: boolean;
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
    emailVerified: args.emailVerified,
    allowUnverifiedEmails: args.allowUnverifiedEmails,
  });
}
