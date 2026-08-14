// The first-login decision: a signed-in session with zero principals
// anywhere gets a personal bench, minted through the native tenant-
// creation route (never a product-owned tenant table of our own),
// parented under the operator tenant when one is configured, and
// seeded with the default workflow set when the hub carries a seed
// model credential. Every step reuses a native route or
// `@workbench/hub-client`; nothing here re-implements tenant creation,
// grant planting, or workflow deployment.

import {
  AssetWithOriginResponse,
  paginatedSchema,
  PrincipalSummary,
  TenantResponse,
} from "@intx/types";
import { type } from "arktype";
import {
  DEFAULT_WORKFLOWS,
  parseAs,
  seedTenant,
  type ApiCall,
  type ModelSource,
  type WorkflowPusher,
  isLiveDeploymentStatus,
} from "@workbench/hub-client";

export type ProvisionResult =
  | {
      readonly kind: "existing-member";
      /**
       * Present only when the caller owns the personal bench this hook
       * itself provisions: `true` once every default workflow is
       * deployed, `false` when it is still waiting on a working
       * credential (the `bench_unseeded` condition the onboarding UI
       * reads to keep the credential step open instead of declaring
       * setup finished). Absent when membership belongs to some other
       * tenant this hook does not own — its seed state is none of this
       * hook's business.
       */
      readonly seeded?: boolean;
    }
  | { readonly kind: "needs-onboarding" }
  | {
      readonly kind: "provisioned";
      readonly tenantId: string;
      readonly tenantSlug: string;
      readonly seeded: boolean;
      readonly seedSkipReason?: string;
    };

/**
 * A typed provisioning failure. `kind` lets the routes layer distinguish
 * a retryable (transient) failure — sidecar down, race, network — from a
 * permanent one — slug conflict with no principal, tenant created but
 * membership missing — so the client can decide whether to retry without
 * parsing a free-text message.
 */
export type ProvisionErrorKind = "transient" | "permanent";

export class ProvisionError extends Error {
  readonly code: string;
  readonly errorKind: ProvisionErrorKind;
  constructor(code: string, message: string, errorKind: ProvisionErrorKind) {
    super(message);
    this.name = "ProvisionError";
    this.code = code;
    this.errorKind = errorKind;
  }
}

export type ProvisionArgs = {
  api: ApiCall;
  cookies: string[];
  hubUrl: string;
  userId: string;
  userEmail: string;
  /** Display name for the personal bench. Required to mint: when omitted
   * (shell membership probe), returns `needs-onboarding` and creates nothing. */
  displayName?: string;
  operatorTenantId?: string;
  seedModel?: ModelSource;
  pushWorkflow: WorkflowPusher;
  log: (line: string) => void;
};

/** A lowercase-kebab personal-bench slug, unique per user without a
 * coordinating registry: the local part of the email plus a short
 * fragment of the user's own id, which the platform already treats as
 * unique. */
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

async function fetchPrincipals(
  api: ApiCall,
  cookies: string[],
): Promise<{ tenantId: string; tenantSlug: string; principalId: string }[]> {
  const response = await api("GET", "/api/me/principals", undefined, cookies);
  const summary = parseAs(
    paginatedSchema(PrincipalSummary),
    response.data,
    "principals response",
  );
  return summary.data.map((p) => ({
    tenantId: p.tenantId,
    tenantSlug: p.tenantSlug,
    principalId: p.principalId,
  }));
}

const WorkflowDeploymentStatus = type({
  definitionAssetId: "string",
  status: "string",
});

/**
 * Whether every default workflow already has an active deployment on
 * this tenant. Read-only: it never creates or deploys anything, it
 * only tells the caller whether `seedTenant` still has work to do —
 * the same asset-then-deployment lookup `seedTenant` itself performs
 * before deciding to skip a step.
 */
async function isFullySeeded(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
): Promise<boolean> {
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

  return DEFAULT_WORKFLOWS.every((workflow) => {
    const asset = assets.find((a) => a.name === workflow.assetName);
    if (!asset) return false;
    return deployments.some(
      (d) =>
        d.definitionAssetId === asset.id && isLiveDeploymentStatus(d.status),
    );
  });
}

/**
 * Runs the first-login hook: checks whether the caller already belongs
 * to any tenant and, if not, provisions and seeds a personal bench for
 * them. Safe to call on every sign-in — an existing member is a single
 * read and nothing else.
 */
export async function provisionPersonalTenantIfNeeded(
  args: ProvisionArgs,
): Promise<ProvisionResult> {
  const expectedSlug = personalTenantSlug(args.userEmail, args.userId);
  const before = await fetchPrincipals(args.api, args.cookies);
  if (before.length > 0) {
    // A membership already exists. If it is not the personal bench this
    // hook itself owns, there is nothing to recover — some other bench
    // added this user, and that is none of this hook's business. If it
    // is our own personal bench, an earlier call may have created the
    // tenant and then failed before seeding it; re-seed rather than
    // silently treating "created but never seeded" as done.
    const own = before.find((p) => p.tenantSlug === expectedSlug);
    // Not our personal bench: some other tenant added this user, which
    // is none of this hook's business. Membership is decided here without
    // depending on a seed credential — recovery of a half-provisioned
    // bench must not hang forever just because no seed model is configured.
    if (!own) return { kind: "existing-member" };

    const fullySeeded = await isFullySeeded(
      args.api,
      args.cookies,
      own.tenantId,
    );
    if (fullySeeded) return { kind: "existing-member", seeded: true };

    // Own bench exists but is not fully seeded. With a hub-owned seed
    // model we can re-seed right here to recover. Without one there is
    // nothing this hook can do — completing seeding from the caller's
    // own credential is `completeCredentialSetup`'s job (the onboarding
    // credential step), not this sign-in hook's — so we exit as an
    // existing-member with `seeded: false`, the typed `bench_unseeded`
    // condition the onboarding UI reads to keep the credential step open
    // rather than declaring setup finished.
    if (!args.seedModel) {
      args.log(
        `personal bench ${own.tenantId} exists but is not fully seeded, and no seed model is configured; returning as existing-member without re-seeding`,
      );
      return { kind: "existing-member", seeded: false };
    }

    const tenantResponse = await args.api(
      "GET",
      `/api/tenants/${own.tenantId}`,
      undefined,
      args.cookies,
    );
    const ownTenant = parseAs(
      TenantResponse,
      tenantResponse.data,
      "tenant response",
    );
    await seedTenant({
      api: args.api,
      cookies: args.cookies,
      hubUrl: args.hubUrl,
      tenant: {
        tenantId: own.tenantId,
        principalId: own.principalId,
        domain: ownTenant.domain,
      },
      model: args.seedModel,
      pushWorkflow: args.pushWorkflow,
      log: args.log,
      workflows: DEFAULT_WORKFLOWS,
    });
    return { kind: "existing-member", seeded: true };
  }

  // No membership yet. Creation requires an explicit display name from the
  // onboarding naming step — a shell membership probe (no name) must not
  // silently mint a personal bench.
  if (args.displayName === undefined || args.displayName.trim().length === 0) {
    return { kind: "needs-onboarding" };
  }

  const tenantCreateBody: { name: string; slug: string; parentId?: string } = {
    name: args.displayName.trim(),
    slug: expectedSlug,
  };
  if (args.operatorTenantId !== undefined)
    tenantCreateBody.parentId = args.operatorTenantId;

  const created = await args.api(
    "POST",
    "/api/tenants",
    tenantCreateBody,
    args.cookies,
  );
  if (created.status === 409) {
    // Lost a race: another concurrent first-login call for this same
    // user already created the (deterministically-slugged) personal
    // bench between our own "zero principals" read and this create. The
    // loser recognizes "someone already provisioned me" rather than
    // surfacing the native route's slug conflict as a failure.
    const afterRace = await fetchPrincipals(args.api, args.cookies);
    if (afterRace.length > 0) return { kind: "existing-member" };
    throw new ProvisionError(
      "slug_conflict_no_principal",
      `first-login provisioning hit a slug conflict creating a personal bench, but the caller still has no principal anywhere: ${JSON.stringify(created.data)}`,
      "permanent",
    );
  }
  if (created.status !== 201) {
    throw new ProvisionError(
      "tenant_create_failed",
      `first-login provisioning could not create a personal bench (status ${created.status}): ${JSON.stringify(created.data)}`,
      created.status >= 500 ? "transient" : "permanent",
    );
  }
  const tenant = parseAs(TenantResponse, created.data, "tenant response");

  const after = await fetchPrincipals(args.api, args.cookies);
  const membership = after.find((p) => p.tenantId === tenant.id);
  if (!membership) {
    throw new ProvisionError(
      "tenant_created_no_membership",
      `personal bench ${tenant.id} was created but the caller has no principal in it`,
      "transient",
    );
  }

  if (!args.seedModel) {
    const seedSkipReason =
      "no hub-owned seed model credential is configured (ANTHROPIC_API_KEY); the bench was provisioned without the default workflow set";
    args.log(`bench ${tenant.slug}: ${seedSkipReason}`);
    return {
      kind: "provisioned",
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      seeded: false,
      seedSkipReason,
    };
  }

  await seedTenant({
    api: args.api,
    cookies: args.cookies,
    hubUrl: args.hubUrl,
    tenant: {
      tenantId: tenant.id,
      principalId: membership.principalId,
      domain: tenant.domain,
    },
    model: args.seedModel,
    pushWorkflow: args.pushWorkflow,
    log: args.log,
    workflows: DEFAULT_WORKFLOWS,
  });

  return {
    kind: "provisioned",
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    seeded: true,
  };
}
