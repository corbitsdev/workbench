import { useNavigate } from "react-router";
import { DataTable, Pagination, type DataTableColumn } from "@workbench/ui";
import type { PrincipalSummary } from "@workbench/shared";
import { useAdminPrincipals } from "../../hooks/use-admin";
import {
  AdminSearchInput,
  AdminSelect,
  FilterBar,
  ListStates,
  adminTableCard,
  encodeBackParam,
  useAdminFilters,
} from "./admin-ui";

const PAGE_SIZE = 25;

const TYPE_OPTIONS = [
  { value: "user", label: "Human" },
  { value: "agent", label: "Agent instance" },
];

const columns: DataTableColumn<PrincipalSummary>[] = [
  {
    key: "principal",
    header: "Principal",
    render: (p) => (
      <span className="font-medium text-text">
        {p.displayName}
        {p.isAdmin && <span className="ml-1.5 text-xs text-orange">admin</span>}
      </span>
    ),
  },
  { key: "kind", header: "Kind", render: (p) => p.kind },
  {
    key: "roles",
    header: "Roles",
    render: (p) =>
      p.roles.length > 0 ? p.roles.map((r) => r.name).join(", ") : "—",
  },
];

export function AdminPrincipals() {
  const navigate = useNavigate();
  const { get, page, setFilter, setPage, searchParams } = useAdminFilters();

  const type = get("type");
  const search = get("search");

  const query = useAdminPrincipals({
    page,
    limit: PAGE_SIZE,
    type: type ? (type as "user" | "agent") : undefined,
    search: search || undefined,
  });

  const principals = query.data?.principals ?? [];
  const pageInfo = query.data?.pageInfo;

  const openDetail = (p: PrincipalSummary) => {
    const back = encodeBackParam(searchParams);
    const backSuffix = back ? `?back=${back}` : "";
    navigate(`/admin/principals/${p.id}${backSuffix}`);
  };

  return (
    <div>
      <p className="mb-4 text-sm text-text-2">
        Human members and agent-instance principals in this tenant. Click a
        principal to view its roles and resolved grants.
      </p>

      <FilterBar>
        <AdminSearchInput
          value={search}
          onChange={(v) => setFilter("search", v)}
          placeholder="Search name or id…"
        />
        <AdminSelect
          ariaLabel="Filter by type"
          value={type}
          onChange={(v) => setFilter("type", v)}
          options={TYPE_OPTIONS}
          allLabel="All types"
        />
      </FilterBar>

      <div className={adminTableCard}>
        <ListStates
          isLoading={query.isLoading}
          isError={query.isError}
          rowCount={principals.length}
          emptyLabel="No principals match these filters."
        >
          <DataTable
            columns={columns}
            rows={principals}
            getRowKey={(p) => p.id}
            onRowClick={openDetail}
            caption="Principals"
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
