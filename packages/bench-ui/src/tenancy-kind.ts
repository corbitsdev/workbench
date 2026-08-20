// The bench switcher's tenancy discriminator. Interchange's tenant row
// carries no `kind`/`type` field (see docs/TENANCY.md's gap list), and
// `/api/me/principals` returns one row per tenant a principal belongs
// to regardless of what kind of tenant it is — a bench, a workbench's
// own child tenancy, or (per `packages/chat`'s `workbench_tenancy` table)
// anything minted the same way in the future (a DM, a shared workbench).
// Workbench owns this convention because the platform does not: a
// membership is a "bench" only when it is not a known workbench child
// tenancy and its name is not a raw platform id — the two ways a tenant
// that is not a bench can otherwise slip into this list unlabeled.

import { isRawIdentifier } from "./membership";
import type { BenchMembership } from "./api";

export type TenancyKind = "bench" | "workbench" | "unknown";

/**
 * Classifies one membership row. `workbenchTenantIds` is the caller's own
 * tenant ids intersected against `packages/chat`'s `workbench_tenancy`
 * table (see `GET`-adjacent `POST /api/workbench-tenancies/kinds`) — the
 * one place that link is recorded, since no native tenant field carries
 * it. `"unknown"` covers a tenant with no human-assigned name (a raw
 * `ins_`/`tnt_`/... id): never a bench, and never worth guessing a
 * kind for, so it is excluded the same as a known workbench.
 */
export function classifyBenchMembership(
  membership: BenchMembership,
  workbenchTenantIds: ReadonlySet<string>,
): TenancyKind {
  if (isRawIdentifier(membership.tenantName)) return "unknown";
  if (workbenchTenantIds.has(membership.tenantId)) return "workbench";
  return "bench";
}

/** The switcher's own list: every membership that is an actual
 * bench, in the order it was given. */
export function filterBenchMemberships(
  memberships: readonly BenchMembership[],
  workbenchTenantIds: ReadonlySet<string>,
): readonly BenchMembership[] {
  return memberships.filter(
    (membership) =>
      classifyBenchMembership(membership, workbenchTenantIds) === "bench",
  );
}
