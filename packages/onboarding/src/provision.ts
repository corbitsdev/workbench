// The first-login decision. The first signup on an empty hub (zero
// tenants, at most the caller's own user row) mints the root tenant
// through the native tenant-creation route — its creator becomes that
// tenant's owner. Every later signup joins the existing root tenant as
// a plain member. This path never seeds workflows, tools, or grants:
// seeding is the credential-completion step's job, driven by the
// user's own credential, never by signup.

import { type ApiCall } from "@corbits/hub-api-client";
import { genesisOrJoinHubSignup, type HubSignupTenancy } from "./genesis";

export { ProvisionError } from "./genesis";
export type { ProvisionErrorKind } from "./genesis";

export type ProvisionResult =
  | {
      /** An account that already belongs somewhere — or has just joined
       * the existing root as a plain member. Either way no wizard: the
       * tenant facts ride along only when the caller just joined, for
       * the member-onboarding UX to surface later (CL-7584). */
      readonly kind: "existing-member";
      readonly tenantId?: string;
      readonly tenantSlug?: string;
    }
  | { readonly kind: "needs-onboarding" }
  | {
      /** The caller just minted the root tenant as its owner (genesis).
       * `seeded` is always `false`: signup provisions membership only;
       * the credential step owns seeding. */
      readonly kind: "provisioned";
      readonly tenantId: string;
      readonly tenantSlug: string;
      readonly seeded: false;
    };

export type ProvisionArgs = {
  api: ApiCall;
  cookies: string[];
  userId: string;
  userEmail: string;
  userEmailVerified: boolean;
  /** Slug for the genesis tenant — the first tenant on an empty hub.
   * Later signups join the existing root and never read this. */
  defaultTenantSlug: string;
  /** Display name for the genesis tenant. Required to mint: when
   * omitted (shell membership probe), returns `needs-onboarding` and
   * creates nothing. */
  displayName?: string;
  tenancy: HubSignupTenancy;
  log: (line: string) => void;
};

/** A lowercase-kebab personal-bench slug, unique per user without a
 * coordinating registry: the local part of the email plus a short
 * fragment of the user's own id, which the platform already treats as
 * unique. Signup no longer mints personal benches, but the credential
 * step still uses this to recognize a bench it provisioned itself. */
export function personalTenantSlug(email: string, userId: string): string {
  const local = email.split("@")[0] ?? email;
  const kebab = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = userId
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-8)
    .toLowerCase();
  return `${kebab || "bench"}-${suffix || "personal"}`;
}

/**
 * Runs the first-login hook by delegating the whole decision to
 * `genesisOrJoinHubSignup` (see ./genesis.ts). Safe to call on every
 * sign-in — an existing member is a single read and nothing else.
 */
export async function provisionPersonalTenantIfNeeded(
  args: ProvisionArgs,
): Promise<ProvisionResult> {
  const result = await genesisOrJoinHubSignup({
    api: args.api,
    cookies: args.cookies,
    userId: args.userId,
    userEmail: args.userEmail,
    userEmailVerified: args.userEmailVerified,
    defaultTenantSlug: args.defaultTenantSlug,
    tenancy: args.tenancy,
    log: args.log,
    ...(args.displayName !== undefined ? { displayName: args.displayName } : {}),
  });
  if (result.kind === "genesis") {
    return {
      kind: "provisioned",
      tenantId: result.tenantId,
      tenantSlug: result.tenantSlug,
      seeded: false,
    };
  }
  if (result.kind === "joined") {
    return {
      kind: "existing-member",
      tenantId: result.tenantId,
      tenantSlug: result.tenantSlug,
    };
  }
  return result;
}
