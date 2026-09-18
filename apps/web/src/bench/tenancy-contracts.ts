// Pure tenancy contracts workbench owns on top of Interchange's native
// tenant hierarchy and roles. No parallel role table, no copied
// inheritance — see docs/TENANCY.md.

import { type } from "arktype";

/** Interchange native roles — mirror 1:1; never invent parallels. */
export const INTERCHANGE_ROLES = ["owner", "admin", "member"] as const;
export type InterchangeRole = (typeof INTERCHANGE_ROLES)[number];

export const WorkbenchIcon = type({
  /** 1–2 character monogram shown in the switcher and badges. */
  monogram: type("string >= 1").pipe((s) => s.slice(0, 2)),
  /** CSS color token or hex; validated loosely at the boundary. */
  color: type("string >= 1"),
});
export type WorkbenchIcon = typeof WorkbenchIcon.infer;

export const DmWorkbenchFlag = type({
  dm: "true",
  memberUserIds: type("string").array().atLeastLength(2).atMostLength(2),
});
export type DmWorkbenchFlag = typeof DmWorkbenchFlag.infer;

// Never invents a third-party name — caller supplies the resolved label.
export function dmWorkbenchName(counterpartyDisplayName: string): string {
  const trimmed = counterpartyDisplayName.trim();
  return trimmed.length > 0 ? trimmed : "Direct message";
}

// The workbench runtime still lives in the owning tenant; this is the
// product shape the create path must honor.
export function createDmWorkbenchSpec(args: {
  readonly counterpartyDisplayName: string;
  readonly memberUserIds: readonly [string, string];
}): {
  readonly name: string;
  readonly dm: true;
  readonly memberUserIds: readonly [string, string];
} {
  const [a, b] = args.memberUserIds;
  if (a === b) {
    throw new Error("DM members must be two distinct user ids");
  }
  return {
    name: dmWorkbenchName(args.counterpartyDisplayName),
    dm: true,
    memberUserIds: [a, b],
  };
}

export type TenantParentLookup = {
  /** Returns the parent id of a tenant, or null if root / unknown. */
  getParentId(tenantId: string): Promise<string | null>;
  /** True when the tenant row exists. */
  exists(tenantId: string): Promise<boolean>;
};

export type ParentValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

// Cycle-safe for create (new id doesn't exist yet). Does not grant-check
// — caller must verify owner separately.
export async function validateParentId(
  parentId: string | null | undefined,
  lookup: TenantParentLookup,
): Promise<ParentValidationResult> {
  if (parentId === null || parentId === undefined || parentId === "") {
    return { ok: true };
  }
  if (!(await lookup.exists(parentId))) {
    return {
      ok: false,
      code: "unknown_parent",
      message: "parent tenant does not exist",
    };
  }
  return { ok: true };
}

// For any future reparent path; create paths pass a not-yet-existing
// childId and always pass.
export async function wouldCreateParentCycle(
  childId: string,
  newParentId: string,
  lookup: TenantParentLookup,
): Promise<boolean> {
  if (childId === newParentId) return true;
  let current: string | null = newParentId;
  const seen = new Set<string>();
  while (current !== null) {
    if (current === childId) return true;
    if (seen.has(current)) return true; // existing cycle in store
    seen.add(current);
    current = await lookup.getParentId(current);
  }
  return false;
}

// Rejects invented roles so UI never drifts from Interchange.
export function isInterchangeRole(value: string): value is InterchangeRole {
  return (INTERCHANGE_ROLES as readonly string[]).includes(value);
}

// Both tenants must share a parent (or one is the parent of the other).
// External cross-org is out of scope.
export async function canShareWorkbenchWithinParent(
  tenantA: string,
  tenantB: string,
  lookup: TenantParentLookup,
): Promise<boolean> {
  if (tenantA === tenantB) return true;
  const parentA = await lookup.getParentId(tenantA);
  const parentB = await lookup.getParentId(tenantB);
  if (parentA !== null && parentA === tenantB) return true;
  if (parentB !== null && parentB === tenantA) return true;
  if (parentA !== null && parentB !== null && parentA === parentB) return true;
  return false;
}
