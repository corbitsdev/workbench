import { Link } from "react-router";
import {
  Badge,
  DataTable,
  Pagination,
  inputFieldClass,
  type DataTableColumn,
} from "@workbench/ui";
import type { BadgeTone } from "@workbench/ui";
import {
  adminAuditActions,
  type AdminAuditAction,
  type AuditRecord,
} from "@workbench/shared";
import { useAuditLog } from "../../hooks/use-admin";
import {
  AdminSearchInput,
  AdminSelect,
  FilterBar,
  ListStates,
  adminTableCard,
  useAdminFilters,
} from "./admin-ui";

const PAGE_SIZE = 25;

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

const ACTION_OPTIONS = adminAuditActions.map((a) => ({
  value: a,
  label: ACTION_LABEL[a],
}));

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
  const { get, page, setFilter, setPage } = useAdminFilters();

  const actor = get("actor");
  const action = get("action");
  const from = get("from");
  const to = get("to");

  const query = useAuditLog({
    page,
    limit: PAGE_SIZE,
    actor: actor || undefined,
    action: action ? (action as AdminAuditAction) : undefined,
    from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
    to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
  });

  const records = query.data?.records ?? [];
  const pageInfo = query.data?.pageInfo;

  return (
    <div>
      <p className="mb-4 text-sm text-text-2">
        Compliance record of cross-principal activity reads (who viewed whose
        timeline) and every admin role change. Newest first.
      </p>

      <FilterBar>
        <AdminSearchInput
          value={actor}
          onChange={(v) => setFilter("actor", v)}
          placeholder="Actor principal id…"
        />
        <AdminSelect
          ariaLabel="Filter by action"
          value={action}
          onChange={(v) => setFilter("action", v)}
          options={ACTION_OPTIONS}
          allLabel="All actions"
        />
        <label className="flex items-center gap-1 text-xs text-text-3">
          From
          <input
            type="date"
            value={from}
            onChange={(e) => setFilter("from", e.target.value)}
            className={inputFieldClass}
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-text-3">
          To
          <input
            type="date"
            value={to}
            onChange={(e) => setFilter("to", e.target.value)}
            className={inputFieldClass}
          />
        </label>
      </FilterBar>

      <div className={adminTableCard}>
        <ListStates
          isLoading={query.isLoading}
          isError={query.isError}
          rowCount={records.length}
          emptyLabel="No audit records match these filters."
        >
          <DataTable
            columns={columns}
            rows={records}
            getRowKey={(r) => r.id}
            caption="Admin audit log"
          />
          {pageInfo && (
            <Pagination
              page={pageInfo.page}
              totalPages={pageInfo.totalPages}
              total={pageInfo.total}
              onPageChange={setPage}
            />
          )}
        </ListStates>
      </div>
    </div>
  );
}
