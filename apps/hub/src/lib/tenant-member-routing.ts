import { and, eq, inArray } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import type { HubDb } from "../db";

const { principal } = intxSchema;

/**
 * Resolve auth `refId`s to their user principal ids within one tenant.
 *
 * This is ROUTING, not roster discovery (CL-4429): who receives a delivery is
 * decided at intake and stored in the schedule payload as `{ refId,
 * displayName }` pairs. What the hub still has to do at run time is turn each
 * stored `refId` into the principal id a mailbox row and an artifact are owned
 * by — the pair carries no principal id, and a workflow pack must never carry
 * tenant-specific ids.
 *
 * A `refId` with no user principal in this tenant is simply absent from the
 * returned map. That is the departed-member case, and the caller reports it as
 * a skip with a reason rather than dropping it silently or failing the batch.
 */
export async function resolvePrincipalIdsByRefId(
  db: HubDb,
  tenantId: string,
  refIds: readonly string[],
): Promise<Map<string, string>> {
  const wanted = [
    ...new Set(refIds.map((r) => r.trim()).filter((r) => r.length > 0)),
  ];
  if (wanted.length === 0) return new Map();
  const rows = await db.query.principal.findMany({
    where: and(
      eq(principal.tenantId, tenantId),
      eq(principal.kind, "user"),
      inArray(principal.refId, wanted),
    ),
  });
  return new Map(rows.map((row) => [row.refId, row.id]));
}
