import { Link, useParams, useSearchParams } from "react-router";
import {
  Badge,
  Breadcrumbs,
  DataTable,
  type DataTableColumn,
} from "@workbench/ui";
import type {
  DefinitionKind,
  WorkflowDeploymentHistoryEntry,
} from "@workbench/shared";
import { useDefinitionDetail } from "../../hooks/use-admin";
import { adminTableCard, backToListPath } from "./admin-ui";

const deploymentColumns: DataTableColumn<WorkflowDeploymentHistoryEntry>[] = [
  {
    key: "deploymentId",
    header: "Deployment",
    className: "font-mono text-xs",
    render: (d) => d.deploymentId ?? "—",
  },
  {
    key: "status",
    header: "Status",
    render: (d) => (
      <Badge tone={d.status === "running" ? "positive" : "neutral"}>
        {d.status}
      </Badge>
    ),
  },
  { key: "version", header: "Version", render: (d) => d.version ?? "—" },
  {
    key: "sha",
    header: "SHA",
    className: "font-mono text-xs",
    render: (d) => d.sha ?? "—",
  },
  { key: "label", header: "Label", render: (d) => d.label ?? "—" },
  {
    key: "when",
    header: "Deployed",
    className: "whitespace-nowrap",
    render: (d) => new Date(d.createdAt).toLocaleString(),
  },
];

function renderLink(to: string, label: string) {
  return <Link to={to}>{label}</Link>;
}

export function DefinitionDetail() {
  const { key } = useParams<{ key: string }>();
  const [searchParams] = useSearchParams();
  const kindParam = searchParams.get("kind");
  const kind =
    kindParam === "workflow" || kindParam === "agent" || kindParam === "tool"
      ? (kindParam as DefinitionKind)
      : null;

  const query = useDefinitionDetail(kind, key ?? null);

  const crumbLabel = query.data?.definition.name ?? key ?? "Definition";
  const definitionsTo = backToListPath(
    "/settings/admin/definitions",
    searchParams.get("back"),
  );

  return (
    <div>
      <Breadcrumbs
        renderLink={renderLink}
        items={[
          { label: "Users & agents", to: "/settings/admin" },
          { label: "Definitions", to: definitionsTo },
          { label: crumbLabel },
        ]}
      />

      {query.isLoading && (
        <p className="text-sm text-text-2">Loading definition…</p>
      )}
      {query.isError && (
        <p className="text-sm text-text-2">
          Could not load this definition. It may have been removed.
        </p>
      )}

      {query.data && (
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-text">
              {query.data.definition.name}
            </h1>
            <Badge tone="accent">{query.data.definition.kind}</Badge>
            <Badge
              tone={
                query.data.definition.status === "deployed" ||
                query.data.definition.status === "running"
                  ? "positive"
                  : "neutral"
              }
            >
              {query.data.definition.status}
            </Badge>
          </div>
          <p className="mt-1 font-mono text-xs text-text-3">
            {query.data.definition.key}
          </p>
          {query.data.definition.description && (
            <p className="mt-2 max-w-2xl text-sm text-text-2">
              {query.data.definition.description}
            </p>
          )}

          {query.data.definition.kind === "workflow" && (
            <div className="mt-6">
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-3">
                Deployment history ({query.data.deployments.length})
              </h2>
              {query.data.deployments.length === 0 ? (
                <p className="text-sm text-text-2">No deployments recorded.</p>
              ) : (
                <div className={adminTableCard}>
                  <DataTable
                    columns={deploymentColumns}
                    rows={query.data.deployments}
                    getRowKey={(d) =>
                      d.deploymentId ?? `${d.status}-${d.createdAt}`
                    }
                    caption="Workflow deployment history"
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
