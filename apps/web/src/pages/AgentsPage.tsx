import {
  AppPageChromeRow,
  Badge,
  CATALOG_GLYPH_FILLS,
  CATALOG_GLYPH_KINDS,
  CatalogGlyph,
  catalogCardClassName,
  cn,
  DataTable,
  hashString,
  LibrarySearchInput,
  PagePanel,
  RichEmptyState,
  useViewMode,
  ViewToggle,
  type BadgeTone,
  type DataTableColumn,
} from "@workbench/ui";
import { Bot, Check, Copy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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

const STATUS_LABEL: Record<string, string> = {
  deployed: "Deployed",
  running: "Running",
  stopped: "Stopped",
  error: "Error",
};

function statusTone(status: string): BadgeTone {
  return STATUS_TONE[status] ?? "neutral";
}

function statusLabel(status: string): string {
  const known = STATUS_LABEL[status];
  if (known !== undefined) return known;
  if (status.length === 0) return status;
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** Filter agents by name, description, or mailbox address (case-insensitive). */
export function filterAgents(
  agents: AgentInstanceItem[],
  query: string,
): AgentInstanceItem[] {
  const q = query.trim().toLowerCase();
  if (q === "") return agents;
  return agents.filter(
    (agent) =>
      agent.name.toLowerCase().includes(q) ||
      (agent.description !== null &&
        agent.description.toLowerCase().includes(q)) ||
      agent.address.toLowerCase().includes(q),
  );
}

function CopyAddressButton({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      aria-label={`Copy address ${address}`}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard
          .writeText(address)
          .then(() => setCopied(true))
          .catch(() => {
            // Clipboard unavailable; the address stays selectable.
          });
      }}
      className="grid h-6 w-6 flex-none place-items-center rounded-[8px] text-text-3 transition-colors hover:bg-page hover:text-text active:scale-[0.97]"
    >
      {copied ? (
        <>
          <Check className="h-3 w-3" />
          <span className="sr-only" role="status">
            Copied
          </span>
        </>
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  );
}

function AgentCard({
  agent,
  index,
}: {
  agent: AgentInstanceItem;
  index: number;
}) {
  const hash = hashString(agent.id);
  const glyph = CATALOG_GLYPH_KINDS[hash % CATALOG_GLYPH_KINDS.length];
  const fill = CATALOG_GLYPH_FILLS[hash % CATALOG_GLYPH_FILLS.length];

  return (
    <div className={cn(catalogCardClassName, "cursor-default")}>
      <span className="absolute left-[10px] top-[10px] z-[2] rounded-full bg-[rgba(0,0,0,0.32)] px-2 py-[3px] text-[10px] font-bold uppercase tracking-[0.03em] text-white backdrop-blur-[6px]">
        {statusLabel(agent.status)}
      </span>
      <div
        className={`relative grid h-[112px] place-items-center overflow-hidden ${fill}`}
      >
        <CatalogGlyph kind={glyph} />
        <span className="absolute bottom-[10px] right-3 font-mono text-[13px] font-bold text-[rgba(255,255,255,0.85)]">
          A{index.toString().padStart(2, "0")}
        </span>
      </div>
      <div className="border-t border-border bg-surface px-[13px] py-[11px]">
        <div className="truncate text-[13.5px] font-semibold text-text">
          {agent.name}
        </div>
        <p className="mt-0.5 line-clamp-2 text-pretty text-[11px] text-text-3">
          {agent.description === null ? "No description" : agent.description}
        </p>
        <div className="mt-1.5 flex items-center gap-1">
          <span className="min-w-0 truncate font-mono text-[10px] text-text-3/80">
            {agent.address}
          </span>
          <CopyAddressButton address={agent.address} />
        </div>
      </div>
    </div>
  );
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
  const { mode: viewMode, setMode: setViewMode } = useViewMode("agents");

  const agentsQuery = useAgentInstances(tenantId);
  const isLoading =
    meQuery.isLoading || (Boolean(tenantId) && agentsQuery.isLoading);
  const isError =
    meQuery.isError ||
    agentsQuery.isError ||
    (!meQuery.isLoading && tenantId === null);

  const filteredAgents = useMemo(() => {
    const agents = agentsQuery.data === undefined ? [] : agentsQuery.data;
    return filterAgents(agents, query);
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
      className: "max-w-[360px]",
      render: (a) => (
        <span className="line-clamp-1 text-text-3">
          {a.description === null ? "—" : a.description}
        </span>
      ),
    },
    {
      key: "address",
      header: "Address",
      render: (a) => (
        <span className="inline-flex max-w-full items-center gap-1">
          <span className="min-w-0 truncate font-mono text-[12px]">
            {a.address}
          </span>
          <CopyAddressButton address={a.address} />
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (a) => (
        <Badge tone={statusTone(a.status)}>{statusLabel(a.status)}</Badge>
      ),
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
        <ViewToggle mode={viewMode} onChange={setViewMode} />
      </AppPageChromeRow>
    ),
    [filteredAgents.length, query, viewMode, setViewMode],
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
        {!isLoading &&
          !isError &&
          filteredAgents.length === 0 &&
          (isSearching ? (
            <div className="py-10 text-[13px] text-text-3">
              No results for &ldquo;{query.trim()}&rdquo;.
            </div>
          ) : (
            <RichEmptyState
              icon={<Bot className="h-6 w-6" strokeWidth={1.75} />}
              title="No agents yet"
              description="Agents available to you will appear here. Creating and configuring agents is coming soon."
            />
          ))}
        {!isLoading &&
          !isError &&
          filteredAgents.length > 0 &&
          (viewMode === "rows" ? (
            <DataTable<AgentInstanceItem>
              caption="Agents"
              rows={filteredAgents}
              getRowKey={(a) => a.id}
              columns={columns}
            />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-[var(--gap)] sm:grid-cols-[repeat(auto-fill,minmax(190px,1fr))]">
              {filteredAgents.map((agent, i) => (
                <AgentCard key={agent.id} agent={agent} index={i + 1} />
              ))}
            </div>
          ))}
      </div>
    </PagePanel>
  );
}
