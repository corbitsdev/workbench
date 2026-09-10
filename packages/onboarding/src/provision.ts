// The first-login decision. The first signup on an empty hub (zero
// tenants, at most the caller's own user row) mints the root tenant
// through the native tenant-creation route — its creator becomes that
// tenant's owner. Every later signup joins the existing root tenant as
// a plain member. This path never seeds workflows, tools, or grants:
// seeding is the credential-completion step's job, driven by the
// user's own credential, never by signup.

import { AssetWithOriginResponse } from "@intx/types";
import { type } from "arktype";
import {
  DEFAULT_WORKFLOWS,
  isCorbitsToolsRegistrySeeded,
  isLiveDeploymentStatus,
} from "@corbits/seeding";
import { parseAs, type ApiCall } from "@corbits/hub-api-client";
import type { AccessPolicyStore } from "@workbench/access-policy";
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
  /** better-auth is configured without `requireEmailVerification` — an
   * unverified email must never pass a domain-allowlist meant for
   * someone else. See `@workbench/access-policy`'s `evaluateSignupGate`
   * doc comment. */
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
  /** The closed-by-default access-policy gate. Join consults it
   * outright (a closed hub never self-grants membership); genesis on an
   * empty hub waives only `signup_closed` — email verification and the
   * domain allowlist still bind the first user. */
  accessPolicy?: {
    store: AccessPolicyStore;
    envSignupMode: "open" | "closed";
    envAllowedDomains: readonly string[];
    allowUnverifiedEmails: boolean;
  };
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

const WorkflowDeploymentStatus = type({
  definitionAssetId: "string",
  status: "string",
});

/** Which of `DEFAULT_WORKFLOWS`' asset names already carry an active
 * deployment on this tenant, split from those that do not — the same
 * asset-then-deployment lookup `isFullySeeded` and `seedTenant` each
 * perform before deciding whether a step has already run. Read-only: it
 * never creates or deploys anything. */
async function seededWorkflowNames(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
): Promise<{ deployed: string[]; pending: string[] }> {
  const assetsResponse = await api(
    "GET",
    `/api/tenants/${tenantId}/assets?kind=workflow&inherited=false`,
    undefined,
    cookies,
  );
  const assets = parseAs(
    AssetWithOriginResponse.array(),
    assetsResponse.data,
    "assets response",
  );

  const deploymentsResponse = await api(
    "GET",
    `/api/tenants/${tenantId}/workflows/deployments`,
    undefined,
    cookies,
  );
  const deployments = parseAs(
    WorkflowDeploymentStatus.array(),
    deploymentsResponse.data,
    "deployments response",
  );

  const deployed: string[] = [];
  const pending: string[] = [];
  for (const workflow of DEFAULT_WORKFLOWS) {
    const asset = assets.find((a) => a.name === workflow.assetName);
    const isDeployed =
      asset !== undefined &&
      deployments.some(
        (d) =>
          d.definitionAssetId === asset.id && isLiveDeploymentStatus(d.status),
      );
    (isDeployed ? deployed : pending).push(workflow.assetName);
  }
  return { deployed, pending };
}

/**
 * Whether every default workflow already has an active deployment on
 * this tenant AND the `corbits-tools` registry exists with the seeded
 * tool-package tarballs (at least `@corbits/memory-tools`). Read-only:
 * it never creates or deploys anything. A dangling empty registry row
 * is not fully seeded — assistant-deployed-but-unpublishable is the
 * first-launch failure this check exists to catch.
 */
export async function isFullySeeded(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
): Promise<boolean> {
  const { pending } = await seededWorkflowNames(api, cookies, tenantId);
  if (pending.length > 0) return false;
  return isCorbitsToolsRegistrySeeded(api, cookies, tenantId);
}

/**
 * The honest partial-seed report `ensureSeeded` reads after catching a
 * sidecar-unavailable deploy failure (CL-6264): which default workflows
 * already deployed before the sidecar dropped out, and which are still
 * waiting on it. Exported so `@workbench/onboarding`'s
 * `complete-credential.ts` never re-derives this asset-then-deployment
 * lookup by hand.
 */
export async function seededWorkflowStatus(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
): Promise<{ deployed: string[]; pending: string[] }> {
  return seededWorkflowNames(api, cookies, tenantId);
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
    ...(args.accessPolicy !== undefined
      ? { accessPolicy: args.accessPolicy }
      : {}),
    ...(args.displayName !== undefined
      ? { displayName: args.displayName }
      : {}),
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
