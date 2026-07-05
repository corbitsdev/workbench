import { Link } from "react-router";
import { Badge, DataTable, type DataTableColumn } from "@workbench/ui";
import type { BadgeTone } from "@workbench/ui";
import type { AdminAuditAction, AuditRecord } from "@workbench/shared";
import { useAuditLog } from "../../hooks/use-admin";
import { QueryStates, adminTableCard } from "./admin-ui";

const ACTION_LABEL: Record<AdminAuditAction, string> = {
  activity_read: "Viewed activity",
  grant_created: "Granted",
  grant_revoked: "Revoked grant",
  role_assigned: "Assigned role",
  role_removed: "Removed role",
};

const ACTION_TONE: Record<AdminAuditAction, BadgeTone> = {
  activity_read: "identity",
  grant_created: "positive",
  grant_revoked: "danger",
  role_assigned: "accent",
  role_removed: "neutral",
};

const columns: DataTableColumn<AuditRecord>[] = [
  {
    key: "when",
    header: "When",
    className: "whitespace-nowrap",
    render: (r) => new Date(r.createdAt).toLocaleString(),
  },
  {
    key: "action",
    header: "Action",
    render: (r) => (
      <Badge tone={ACTION_TONE[r.action]}>{ACTION_LABEL[r.action]}</Badge>
    ),
  },
  {
    key: "actor",
    header: "Actor",
    render: (r) => r.actorName ?? r.actorPrincipalId,
  },
  {
    key: "target",
    header: "Target",
    render: (r) =>
      r.targetPrincipalId ? (
        <Link
          to={`/insights/users/${r.targetPrincipalId}`}
          className="text-orange hover:underline"
        >
          {r.targetName ?? r.targetPrincipalId}
        </Link>
      ) : (
        "—"
      ),
  },
  {
    key: "detail",
    header: "Detail",
    className: "font-mono text-xs",
    render: (r) => r.resource ?? "—",
  },
];

export function AdminAudit() {
  const query = useAuditLog(true);

  return (
    <div>
      <p className="mb-4 text-sm text-text-2">
        Compliance record of cross-principal activity reads (who viewed whose
        timeline) and every admin role change. Newest first.
      </p>

      <div className={adminTableCard}>
        <QueryStates
          query={query}
          emptyLabel="No audit records yet. Cross-principal reads and role changes will appear here."
        >
          {(rows) => (
            <DataTable
              columns={columns}
              rows={rows}
              getRowKey={(r) => r.id}
              caption="Admin audit log"
            />
          )}
        </QueryStates>
      </div>
    </div>
  );
}
