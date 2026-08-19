// Finding a person in their org tenant. A principal is scoped to one
// tenancy and the user behind it is the durable identity, so a person
// acting in any workbench under an org is the same person in that org —
// the mechanism `@intx/hub-api`'s `createResolveTenant` already uses to
// seat a caller in any tenancy, reused here rather than reinvented.
//
// Two callers, one rule: `./memory-mount.ts` resolves the browser caller
// this way, and `./run-hub-grants.ts` resolves a run's invoker this way
// before intersecting their authority. Both must agree on who a person is
// in an org, or a run could be bounded by a different identity than the
// one the routes authorize.
import { and, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { principal } from "@intx/db/schema";

/**
 * The org tenant's own principal id for a user, or `null` when they hold
 * none there — a guest invited into a single workbench whose own parent
 * tenancy is elsewhere.
 */
export async function resolveOrgPrincipalId(
  db: DB["db"],
  orgTenantId: string,
  userRefId: string,
): Promise<string | null> {
  const row = await db.query.principal.findFirst({
    where: and(
      eq(principal.tenantId, orgTenantId),
      eq(principal.kind, "user"),
      eq(principal.refId, userRefId),
    ),
  });
  return row?.id ?? null;
}

/**
 * The user a principal stands for, or `null` when that principal is not a
 * person's. A run's own principal is `kind: "workflow"` and stands for no
 * user, which is precisely why a run needs an invoker to be bounded by.
 */
export async function resolveUserRefIdForPrincipal(
  db: DB["db"],
  principalId: string,
): Promise<string | null> {
  const row = await db.query.principal.findFirst({
    where: eq(principal.id, principalId),
  });
  if (row === undefined || row.kind !== "user") return null;
  return row.refId;
}
