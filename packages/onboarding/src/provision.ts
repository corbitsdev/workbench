// The first-login decision: a signed-in session with zero principals
// anywhere gets a personal org, minted through the native tenant-
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
} from "@workbench/hub-client";

export type ProvisionResult =
  | { readonly kind: "existing-member"; readonly seeded?: true }
  | {
      readonly kind: "provisioned";
      readonly tenantId: string;
      readonly tenantSlug: string;
      readonly seeded: boolean;
      readonly seedSkipReason?: string;
    };

export type ProvisionArgs = {
  api: ApiCall;
  cookies: string[];
  hubUrl: string;
  userId: string;
  userEmail: string;
  operatorTenantId?: string;
  seedModel?: ModelSource;
  pushWorkflow: WorkflowPusher;
  log: (line: string) => void;
};

/** A lowercase-kebab personal-org slug, unique per user without a
 * coordinating registry: the local part of the email plus a short
 * fragment of the user's own id, which the platform already treats as
 * unique. */
export function personalOrgSlug(email: string, userId: string): string {
  const local = email.split("@")[0] ?? email;
  const kebab = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = userId
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-8)
    .toLowerCase();
  return `${kebab || "org"}-${suffix || "personal"}`;
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
    `/api/tenants/${tenantId}/assets?kind=workflow`,
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
    `/api/tenants/${tenantId}/workflows/instances`,
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
      (d) => d.definitionAssetId === asset.id && d.status === "active",
    );
  });
}

/**
 * Runs the first-login hook: checks whether the caller already belongs
 * to any tenant and, if not, provisions and seeds a personal org for
 * them. Safe to call on every sign-in — an existing member is a single
 * read and nothing else.
 */
export async function provisionPersonalOrgIfNeeded(
  args: ProvisionArgs,
): Promise<ProvisionResult> {
  const expectedSlug = personalOrgSlug(args.userEmail, args.userId);
  const before = await fetchPrincipals(args.api, args.cookies);
  if (before.length > 0) {
    // A membership already exists. If it is not the personal org this
    // hook itself owns, there is nothing to recover — some other org
    // added this user, and that is none of this hook's business. If it
    // is our own personal org, an earlier call may have created the
    // tenant and then failed before seeding it; re-seed rather than
    // silently treating "created but never seeded" as done.
    const own = before.find((p) => p.tenantSlug === expectedSlug);
    if (!own || !args.seedModel) return { kind: "existing-member" };
    if (await isFullySeeded(args.api, args.cookies, own.tenantId)) {
      return { kind: "existing-member" };
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

  const tenantCreateBody: { name: string; slug: string; parentId?: string } = {
    name: `${args.userEmail.split("@")[0] ?? args.userEmail}'s workbench`,
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
    // org between our own "zero principals" read and this create. The
    // loser recognizes "someone already provisioned me" rather than
    // surfacing the native route's slug conflict as a failure.
    const afterRace = await fetchPrincipals(args.api, args.cookies);
    if (afterRace.length > 0) return { kind: "existing-member" };
    throw new Error(
      `first-login provisioning hit a slug conflict creating a personal org, but the caller still has no principal anywhere: ${JSON.stringify(created.data)}`,
    );
  }
  if (created.status !== 201) {
    throw new Error(
      `first-login provisioning could not create a personal org (status ${created.status}): ${JSON.stringify(created.data)}`,
    );
  }
  const tenant = parseAs(TenantResponse, created.data, "tenant response");

  const after = await fetchPrincipals(args.api, args.cookies);
  const membership = after.find((p) => p.tenantId === tenant.id);
  if (!membership) {
    throw new Error(
      `personal org ${tenant.id} was created but the caller has no principal in it`,
    );
  }

  if (!args.seedModel) {
    const seedSkipReason =
      "no hub-owned seed model credential is configured (WORKBENCH_SEED_MODEL_*); the org was provisioned without the default workflow set";
    args.log(`org ${tenant.slug}: ${seedSkipReason}`);
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
