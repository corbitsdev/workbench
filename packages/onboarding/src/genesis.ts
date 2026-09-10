// First empty-hub signup mints the root tenant (native owner = superadmin).
// Later signups join that tenant as member. This path never seeds workflows,
// tools, or grants.

import { paginatedSchema, PrincipalSummary, TenantResponse } from "@intx/types";
import { parseAs, type ApiCall } from "@corbits/hub-api-client";
import type { AccessPolicyStore } from "@workbench/access-policy";

export type HubSignupTenancy = {
  countUsers(): Promise<number>;
  countTenants(): Promise<number>;
  findRootTenant(): Promise<{ id: string; slug: string } | null>;
  addActiveMember(args: {
    tenantId: string;
    userId: string;
    roleName: "member";
  }): Promise<{ principalId: string }>;
};

export type GenesisOrJoinArgs = {
  api: ApiCall;
  cookies: string[];
  userId: string;
  userEmail: string;
  userEmailVerified: boolean;
  defaultTenantSlug: string;
  displayName?: string;
  tenancy: HubSignupTenancy;
  accessPolicy?: {
    store: AccessPolicyStore;
    envSignupMode: "open" | "closed";
    envAllowedDomains: readonly string[];
    allowUnverifiedEmails: boolean;
  };
  log: (line: string) => void;
};

export type GenesisOrJoinResult =
  | {
      readonly kind: "genesis";
      readonly tenantId: string;
      readonly tenantSlug: string;
    }
  | {
      readonly kind: "joined";
      readonly tenantId: string;
      readonly tenantSlug: string;
      readonly principalId: string;
    }
  | { readonly kind: "existing-member" }
  | { readonly kind: "needs-onboarding" };

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

async function joinRoot(
  args: GenesisOrJoinArgs,
  root: { id: string; slug: string },
): Promise<GenesisOrJoinResult> {
  const { principalId } = await args.tenancy.addActiveMember({
    tenantId: root.id,
    userId: args.userId,
    roleName: "member",
  });
  args.log(
    `joined existing hub tenant ${root.slug} (${root.id}) as member principal ${principalId}`,
  );
  return {
    kind: "joined",
    tenantId: root.id,
    tenantSlug: root.slug,
    principalId,
  };
}

async function requireRoot(tenancy: HubSignupTenancy): Promise<{
  id: string;
  slug: string;
}> {
  const root = await tenancy.findRootTenant();
  if (root === null) {
    throw new ProvisionError(
      "root_tenant_missing",
      "signup join path found no root tenant (parentId IS NULL)",
      "permanent",
    );
  }
  return root;
}

export async function genesisOrJoinHubSignup(
  args: GenesisOrJoinArgs,
): Promise<GenesisOrJoinResult> {
  const before = await fetchPrincipals(args.api, args.cookies);
  if (before.length > 0) return { kind: "existing-member" };

  const tenantCount = await args.tenancy.countTenants();
  const userCount = await args.tenancy.countUsers();
  if (tenantCount > 0 || userCount > 1) {
    return joinRoot(args, await requireRoot(args.tenancy));
  }

  if (args.displayName === undefined || args.displayName.trim().length === 0) {
    return { kind: "needs-onboarding" };
  }

  const created = await args.api(
    "POST",
    "/api/tenants",
    {
      name: args.displayName.trim(),
      slug: args.defaultTenantSlug,
    },
    args.cookies,
  );
  if (created.status === 409) {
    const root = await args.tenancy.findRootTenant();
    if (root !== null) return joinRoot(args, root);
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
  if (membership === undefined) {
    throw new ProvisionError(
      "tenant_created_no_membership",
      `personal bench ${tenant.id} was created but the caller has no principal in it`,
      "transient",
    );
  }
  args.log(
    `genesis tenant ${tenant.slug} (${tenant.id}) minted for ${args.userEmail}`,
  );
  return {
    kind: "genesis",
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
  };
}
