import { useState } from "react";
import { Link } from "react-router";
import { Badge, DataTable, type DataTableColumn } from "@workbench/ui";
import type {
  AgentDefinitionSummary,
  ToolDefinitionSummary,
  WorkflowDefinitionSummary,
} from "@workbench/shared";
import {
  useAgentDefinitions,
  useToolDefinitions,
  useWorkflowDefinitions,
} from "../../hooks/use-admin";
import { QueryStates, adminTableCard, tabButtonClass } from "./admin-ui";

type Tab = "workflows" | "agents" | "tools";

const TABS: { id: Tab; label: string }[] = [
  { id: "workflows", label: "Workflows" },
  { id: "agents", label: "Agents" },
  { id: "tools", label: "Tools" },
];

const workflowColumns: DataTableColumn<WorkflowDefinitionSummary>[] = [
  { key: "kind", header: "Kind", render: (d) => d.kind },
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
  { key: "label", header: "Label", render: (d) => d.label ?? "—" },
  {
    key: "deployed",
    header: "Deployed",
    render: (d) => new Date(d.createdAt).toLocaleDateString(),
  },
  {
    key: "runs",
    header: "",
    render: () => (
      <Link to="/workflows" className="text-orange hover:underline">
        Runs
      </Link>
    ),
  },
];

const agentColumns: DataTableColumn<AgentDefinitionSummary>[] = [
  { key: "name", header: "Name", render: (a) => a.name },
  { key: "version", header: "Version", render: (a) => a.version },
  {
    key: "status",
    header: "Status",
    render: (a) => (
      <Badge tone={a.status === "deployed" ? "positive" : "neutral"}>
        {a.status}
      </Badge>
    ),
  },
  {
    key: "description",
    header: "Description",
    render: (a) => a.description ?? "—",
  },
];

const toolColumns: DataTableColumn<ToolDefinitionSummary>[] = [
  { key: "name", header: "Name", render: (t) => t.name },
  { key: "provider", header: "Provider", render: (t) => t.providerName },
  { key: "version", header: "Version", render: (t) => t.version ?? "—" },
  { key: "description", header: "Description", render: (t) => t.description },
];

export function AdminDefinitions() {
  const [tab, setTab] = useState<Tab>("workflows");
  const workflows = useWorkflowDefinitions(tab === "workflows");
  const agents = useAgentDefinitions(tab === "agents");
  const tools = useToolDefinitions(tab === "tools");

  return (
    <div>
      <p className="mb-4 text-sm text-text-2">
        Read-only view of the definitions that back the workbench. Editing and
        publishing stay in the admin CLI.
      </p>

      <div className="mb-3 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={tabButtonClass(tab === t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className={adminTableCard}>
        {tab === "workflows" && (
          <QueryStates
            query={workflows}
            emptyLabel="No active workflow deployments."
          >
            {(rows) => (
              <DataTable
                columns={workflowColumns}
                rows={rows}
                getRowKey={(d) => d.deploymentId ?? `${d.kind}-${d.createdAt}`}
                caption="Workflow deployments"
              />
            )}
          </QueryStates>
        )}

        {tab === "agents" && (
          <QueryStates query={agents} emptyLabel="No agent definitions.">
            {(rows) => (
              <DataTable
                columns={agentColumns}
                rows={rows}
                getRowKey={(a) => a.id}
                caption="Agent definitions"
              />
            )}
          </QueryStates>
        )}

        {tab === "tools" && (
          <QueryStates query={tools} emptyLabel="No tools available.">
            {(rows) => (
              <DataTable
                columns={toolColumns}
                rows={rows}
                getRowKey={(t) => t.name}
                caption="Tool definitions"
              />
            )}
          </QueryStates>
        )}
      </div>
    </div>
  );
}
