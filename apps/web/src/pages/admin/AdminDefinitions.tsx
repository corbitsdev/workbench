import { useNavigate } from "react-router";
import {
  Badge,
  DataTable,
  Pagination,
  type DataTableColumn,
} from "@workbench/ui";
import {
  definitionStatuses,
  type DefinitionKind,
  type DefinitionSummary,
} from "@workbench/shared";
import { useAdminDefinitions } from "../../hooks/use-admin";
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

const KIND_OPTIONS = [
  { value: "workflow", label: "Workflow" },
  { value: "agent", label: "Agent" },
  { value: "tool", label: "Tool" },
];

const STATUS_OPTIONS = definitionStatuses.map((s) => ({ value: s, label: s }));

const KIND_TONE: Record<DefinitionKind, "accent" | "identity" | "neutral"> = {
  workflow: "accent",
  agent: "identity",
  tool: "neutral",
};

const columns: DataTableColumn<DefinitionSummary>[] = [
  {
    key: "name",
    header: "Name",
    render: (d) => <span className="font-medium text-text">{d.name}</span>,
  },
  {
    key: "kind",
    header: "Kind",
    render: (d) => <Badge tone={KIND_TONE[d.kind]}>{d.kind}</Badge>,
  },
  {
    key: "status",
    header: "Status",
    render: (d) => (
      <Badge tone={d.status === "deployed" ? "positive" : "neutral"}>
        {d.status}
      </Badge>
    ),
  },
  { key: "version", header: "Version", render: (d) => d.version ?? "—" },
  {
    key: "deployments",
    header: "Deployments",
    render: (d) => (d.kind === "workflow" ? d.deploymentCount : "—"),
  },
];

export function AdminDefinitions() {
  const navigate = useNavigate();
  const { get, page, setFilter, setPage, searchParams } = useAdminFilters();

  const kind = get("kind");
  const status = get("status");
  const search = get("search");

  const query = useAdminDefinitions({
    page,
    limit: PAGE_SIZE,
    kind: kind ? (kind as DefinitionKind) : undefined,
    status: status || undefined,
    search: search || undefined,
  });

  const definitions = query.data?.definitions ?? [];
  const pageInfo = query.data?.pageInfo;

  const openDetail = (d: DefinitionSummary) => {
    const back = encodeBackParam(searchParams);
    const backSuffix = back ? `&back=${back}` : "";
    navigate(
      `/admin/definitions/${encodeURIComponent(d.key)}?kind=${d.kind}${backSuffix}`,
    );
  };

  return (
    <div>
      <p className="mb-4 text-sm text-text-2">
        The distinct workflow, agent, and tool definitions the workbench can
        run. Workflows are grouped by kind with a deployment count; ephemeral
        per-run deployments are excluded. Read-only — editing stays in the admin
        CLI.
      </p>

      <FilterBar>
        <AdminSearchInput
          value={search}
          onChange={(v) => setFilter("search", v)}
          placeholder="Search name or key…"
        />
        <AdminSelect
          ariaLabel="Filter by kind"
          value={kind}
          onChange={(v) => setFilter("kind", v)}
          options={KIND_OPTIONS}
          allLabel="All kinds"
        />
        <AdminSelect
          ariaLabel="Filter by status"
          value={status}
          onChange={(v) => setFilter("status", v)}
          options={STATUS_OPTIONS}
          allLabel="All statuses"
        />
      </FilterBar>

      <div className={adminTableCard}>
        <ListStates
          isLoading={query.isLoading}
          isError={query.isError}
          rowCount={definitions.length}
          emptyLabel="No definitions match these filters."
        >
          <DataTable
            columns={columns}
            rows={definitions}
            getRowKey={(d) => `${d.kind}:${d.key}`}
            onRowClick={openDetail}
            caption="Definitions"
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
