import { and, count, desc, eq, gte, ilike, lte, type SQL } from "drizzle-orm";
import { getLogger } from "@intx/log";
import type { AdminAuditAction, AuditRecord } from "@workbench/shared";
import type { HubDb } from "../db";
import { adminAudit } from "../db/schema";
import { resolvePrincipalNames } from "./admin-governance";

const log = getLogger(["hub", "admin-audit"]);

export interface RecordAuditArgs {
  db: HubDb;
  tenantId: string;
  action: AdminAuditAction;
  actorPrincipalId: string;
  targetPrincipalId?: string | null;
  resource?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Write one compliance audit row. Best-effort by contract: an audit-write
 * failure must never fail the request it records (a cross-principal read still
 * succeeds even if the audit insert throws), so callers `void` this and it logs
 * rather than rethrows.
 */
export async function recordAudit(args: RecordAuditArgs): Promise<void> {
  try {
    await args.db.insert(adminAudit).values({
      tenantId: args.tenantId,
      action: args.action,
      actorPrincipalId: args.actorPrincipalId,
      targetPrincipalId: args.targetPrincipalId ?? null,
      resource: args.resource ?? null,
      detail: args.detail ?? null,
    });
  } catch (err) {
    log.error("admin audit write failed", {
      action: args.action,
      actorPrincipalId: args.actorPrincipalId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const MAX_AUDIT_LIMIT = 500;

export interface AuditListFilter {
  /** Case-insensitive substring match on the actor principal id. */
  actor?: string | undefined;
  /** Exact audit action. */
  action?: AdminAuditAction | undefined;
  /** Inclusive lower bound on `createdAt`. */
  from?: Date | undefined;
  /** Inclusive upper bound on `createdAt`. */
  to?: Date | undefined;
  page: number;
  limit: number;
}

export interface AuditListPage {
  records: AuditRecord[];
  total: number;
}

/**
 * Newest-first compliance audit records, filtered (actor / action / date range)
 * and paginated (CL-2807). Every filter is applied in SQL so the `total` used
 * for pagination reflects the filtered set, not the whole log. Actor/target
 * display names are resolved for the returned page only.
 */
export async function listAuditRecords(
  db: HubDb,
  tenantId: string,
  filter: AuditListFilter,
): Promise<AuditListPage> {
  const limit = Math.min(Math.max(1, filter.limit), MAX_AUDIT_LIMIT);
  const page = Math.max(1, filter.page);

  const conditions: SQL[] = [eq(adminAudit.tenantId, tenantId)];
  if (filter.actor && filter.actor.trim() !== "") {
    conditions.push(ilike(adminAudit.actorPrincipalId, `%${filter.actor}%`));
  }
  if (filter.action) conditions.push(eq(adminAudit.action, filter.action));
  if (filter.from) conditions.push(gte(adminAudit.createdAt, filter.from));
  if (filter.to) conditions.push(lte(adminAudit.createdAt, filter.to));
  const where = and(...conditions);

  const totalRows = await db
    .select({ total: count() })
    .from(adminAudit)
    .where(where);
  const total = totalRows[0]?.total ?? 0;

  const rows = await db
    .select()
    .from(adminAudit)
    .where(where)
    .orderBy(desc(adminAudit.createdAt))
    .limit(limit)
    .offset((page - 1) * limit);

  const ids = rows.flatMap((r) =>
    r.targetPrincipalId
      ? [r.actorPrincipalId, r.targetPrincipalId]
      : [r.actorPrincipalId],
  );
  const names = await resolvePrincipalNames(db, tenantId, ids);

  const records = rows.map((r) => ({
    id: r.id,
    action: r.action,
    actorPrincipalId: r.actorPrincipalId,
    actorName: names.get(r.actorPrincipalId) ?? null,
    targetPrincipalId: r.targetPrincipalId ?? null,
    targetName: r.targetPrincipalId
      ? (names.get(r.targetPrincipalId) ?? null)
      : null,
    resource: r.resource ?? null,
    detail: r.detail ? JSON.stringify(r.detail) : null,
    createdAt: r.createdAt.toISOString(),
  }));
  return { records, total };
}
