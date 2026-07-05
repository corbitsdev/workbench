import { desc, eq } from "drizzle-orm";
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

const DEFAULT_AUDIT_LIMIT = 100;
const MAX_AUDIT_LIMIT = 500;

export async function listAuditRecords(
  db: HubDb,
  tenantId: string,
  limit = DEFAULT_AUDIT_LIMIT,
): Promise<AuditRecord[]> {
  const capped = Math.min(Math.max(1, limit), MAX_AUDIT_LIMIT);
  const rows = await db
    .select()
    .from(adminAudit)
    .where(eq(adminAudit.tenantId, tenantId))
    .orderBy(desc(adminAudit.createdAt))
    .limit(capped);

  const ids = rows.flatMap((r) =>
    r.targetPrincipalId
      ? [r.actorPrincipalId, r.targetPrincipalId]
      : [r.actorPrincipalId],
  );
  const names = await resolvePrincipalNames(db, tenantId, ids);

  return rows.map((r) => ({
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
}
