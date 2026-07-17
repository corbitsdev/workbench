import {
  AppPageChromeRow,
  Badge,
  DataTable,
  LibrarySearchInput,
  PagePanel,
  type BadgeTone,
  type DataTableColumn,
} from "@workbench/ui";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSetPageChrome } from "../lib/page-chrome";
import { useAgentInstances, type AgentInstanceItem } from "../hooks/use-agents";
import { getMe } from "../lib/hub-api";

const STATUS_TONE: Record<string, BadgeTone> = {
  deployed: "positive",
  running: "positive",
  stopped: "neutral",
  error: "danger",
};

function statusTone(status: string): BadgeTone {
  return STATUS_TONE[status] ?? "neutral";
}

export function AgentsPage() {
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: getMe,
    staleTime: 5 * 60_000,
  });
  const tenantId =
    meQuery.data === undefined ? null : meQuery.data.personalTenantId;
  const [query, setQuery] = useState("");

  const agentsQuery = useAgentInstances(tenantId);
  const isLoading =
    meQuery.isLoading || (Boolean(tenantId) && agentsQuery.isLoading);
  const isError =
    meQuery.isError ||
    agentsQuery.isError ||
    (!meQuery.isLoading && tenantId === null);

  const filteredAgents = useMemo(() => {
    const q = query.trim().toLowerCase();
    const agents = agentsQuery.data === undefined ? [] : agentsQuery.data;
    if (q === "") return agents;
    return agents.filter(
      (agent) =>
        agent.name.toLowerCase().includes(q) ||
        (agent.description !== null &&
          agent.description.toLowerCase().includes(q)) ||
        agent.address.toLowerCase().includes(q),
    );
  }, [query, agentsQuery.data]);

  const isSearching = query.trim().length > 0;

  const columns: DataTableColumn<AgentInstanceItem>[] = [
    {
      key: "name",
      header: "Name",
      className: "font-medium text-text",
      render: (a) => a.name,
    },
    {
      key: "description",
      header: "Description",
      render: (a) => (a.description === null ? "\u2014" : a.description),
    },
    {
      key: "address",
      header: "Address",
      className: "font-mono text-[12px]",
      render: (a) => a.address,
    },
    {
      key: "status",
      header: "Status",
      render: (a) => <Badge tone={statusTone(a.status)}>{a.status}</Badge>,
    },
  ];

  const pageChrome = useMemo(
    () => (
      <AppPageChromeRow title="Agents" count={filteredAgents.length}>
        <LibrarySearchInput
          label="Search agents"
          placeholder="Search agents"
          value={query}
          onChange={setQuery}
        />
      </AppPageChromeRow>
    ),
    [filteredAgents.length, query],
  );
  useSetPageChrome(pageChrome);

  return (
    <PagePanel>
      <div className="flex-1 px-4 pb-10 pt-1.5 sm:px-7">
        {isLoading && (
          <div className="py-10 text-[13px] text-text-3">Loading agents…</div>
        )}
        {!isLoading && isError && (
          <div className="py-10 text-[13px] text-text-3">
            Could not load agents.
          </div>
        )}
        {!isLoading && !isError && filteredAgents.length === 0 && (
          <div className="py-10 text-[13px] text-text-3">
            {isSearching ? (
              <>No results for &ldquo;{query.trim()}&rdquo;.</>
            ) : (
              <>No agents yet. Agents available to you will appear here.</>
            )}
          </div>
        )}
        {!isLoading && !isError && filteredAgents.length > 0 && (
          <DataTable<AgentInstanceItem>
            caption="Agents"
            rows={filteredAgents}
            getRowKey={(a) => a.id}
            columns={columns}
          />
        )}
      </div>
    </PagePanel>
  );
}
