// The client's needs-list: the portable desired state for one user.
// The client holds this list and drives the experience against a stock
// Interchange hub — the hub never learns workbench product concepts. One
// manifest covers the primary tenant (with this user's principal), the
// Myra workflow agent running at top level (by definition refId), every
// workbench sub-tenant with its principals (the same refIds projected in,
// each with per-tenant status and roles), and the memberships/shares that
// project workbenches sideways. The client also keeps its own list of the
// workbench tenant ids it created, so a reinstall can reclaim them by id
// instead of guessing by slug.

import { type } from "arktype";

// The manifest version is a numeric tag pinned to 1: arktype object
// literals only take string/object values, so the literal rides a narrow.
const ManifestVersion = type("number").narrow(
  (version, ctx) => version === 1 || ctx.mustBe("manifest version 1"),
);

export const NeedsListSchema = type({
  version: ManifestVersion,
  user: {
    id: "string",
    "email?": "string",
  },
  primaryTenant: {
    slug: "string",
    name: "string",
  },
  myra: {
    definitionRefId: "string",
    scope: "'top-level'",
    want: "'running'",
  },
  workbenches: type({
    slug: "string",
    name: "string",
    parentSlug: "string",
    members: type({
      refId: "string",
      kind: "'user'",
      "email?": "string",
      status: "'active'",
      roles: "string[]",
    }).array(),
  }).array(),
  shares: type({
    workbenchSlug: "string",
    email: "string",
  }).array(),
  createdWorkbenchTenantIds: "string[]",
});

export type NeedsList = typeof NeedsListSchema.infer;

export type NeedsListInput = {
  readonly user: { readonly id: string; readonly email?: string };
  readonly primaryTenant: { readonly slug: string; readonly name: string };
  readonly myraDefinitionRefId: string;
  readonly workbenches: readonly {
    readonly slug: string;
    readonly name: string;
    readonly members?: readonly {
      readonly refId: string;
      readonly email?: string;
      readonly role?: string;
    }[];
  }[];
  readonly shares?: readonly {
    readonly workbenchSlug: string;
    readonly email: string;
  }[];
  readonly createdWorkbenchTenantIds?: readonly string[];
};

/**
 * Builds the desired state for one user: the primary tenant exists with
 * this user's principal, the Myra agent (by definition refId) runs at the
 * top level, and each workbench hangs under the primary tenant carrying
 * the same member refIds with per-tenant roles. Pure — no hub reads, no
 * storage; the driver diffs this against the hub.
 */
export function buildNeedsList(input: NeedsListInput): NeedsList {
  return {
    version: 1 as const,
    ...(input.user.email === undefined
      ? { user: { id: input.user.id } }
      : { user: { id: input.user.id, email: input.user.email } }),
    primaryTenant: {
      slug: input.primaryTenant.slug,
      name: input.primaryTenant.name,
    },
    myra: {
      definitionRefId: input.myraDefinitionRefId,
      scope: "top-level" as const,
      want: "running" as const,
    },
    workbenches: input.workbenches.map((workbench) => ({
      slug: workbench.slug,
      name: workbench.name,
      parentSlug: input.primaryTenant.slug,
      members: (workbench.members ?? []).map((member) => ({
        refId: member.refId,
        kind: "user" as const,
        ...(member.email === undefined ? {} : { email: member.email }),
        status: "active" as const,
        roles: [member.role ?? "member"],
      })),
    })),
    shares: (input.shares ?? []).map((share) => ({
      workbenchSlug: share.workbenchSlug,
      email: share.email,
    })),
    createdWorkbenchTenantIds: [...(input.createdWorkbenchTenantIds ?? [])],
  };
}

/** Validates untrusted input (storage, postMessage, tests) as a NeedsList. */
export function parseNeedsList(data: unknown) {
  return NeedsListSchema(data);
}

const CREATED_TENANT_IDS_KEY = "workbench.needs-list.created-tenant-ids";

export type StringStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/**
 * The client-kept list of workbench tenant ids it created. Stored as a
 * JSON string array; a corrupt row reads as empty rather than throwing,
 * so a damaged localStorage can never block convergence.
 */
export function loadCreatedWorkbenchTenantIds(
  storage: StringStorage,
): string[] {
  const raw = storage.getItem(CREATED_TENANT_IDS_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

/** Records one created workbench tenant id, keeping insertion order. */
export function recordCreatedWorkbenchTenantId(
  storage: StringStorage,
  tenantId: string,
): void {
  const ids = loadCreatedWorkbenchTenantIds(storage);
  if (!ids.includes(tenantId)) ids.push(tenantId);
  storage.setItem(CREATED_TENANT_IDS_KEY, JSON.stringify(ids));
}
