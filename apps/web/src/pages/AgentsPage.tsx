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
import {
  useAgentInstances,
  useAgentTemplates,
  type AgentInstanceItem,
  type AgentTemplateItem,
} from "../hooks/use-agents";
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

// Unified card/row shape for both a definition (0..N deployed instances,
// tools known) and an orphaned deployed instance with no matching definition
// (always exactly 1 instance, tools unknown — `tools: null`).
export type AgentCardItem = {
  id: string;
  name: string;
  description: string | null;
  tools: string[] | null;
  instances: AgentInstanceItem[];
};

/** Filter agent definitions by name or description (case-insensitive). */
export function filterAgentDefinitions(
  definitions: AgentTemplateItem[],
  query: string,
): AgentTemplateItem[] {
  const q = query.trim().toLowerCase();
  if (q === "") return definitions;
  return definitions.filter(
    (definition) =>
      definition.name.toLowerCase().includes(q) ||
      definition.description.toLowerCase().includes(q),
  );
}

/** Filter agent instances by name, description, or mailbox address (case-insensitive). */
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

function InstanceRow({ instance }: { instance: AgentInstanceItem }) {
  return (
    <div className="flex items-center gap-1.5">
      <Badge tone={statusTone(instance.status)}>
        {statusLabel(instance.status)}
      </Badge>
      <span className="min-w-0 truncate font-mono text-[10px] text-text-3/80">
        {instance.address}
      </span>
      <CopyAddressButton address={instance.address} />
    </div>
  );
}

function cardCornerLabel(instances: AgentInstanceItem[]): string {
  if (instances.length === 0) return "Not deployed";
  if (instances.length === 1) return statusLabel(instances[0].status);
  return `${instances.length} deployed`;
}

function AgentCard({ item, index }: { item: AgentCardItem; index: number }) {
  const hash = hashString(item.id);
  const glyph = CATALOG_GLYPH_KINDS[hash % CATALOG_GLYPH_KINDS.length];
  const fill = CATALOG_GLYPH_FILLS[hash % CATALOG_GLYPH_FILLS.length];

  return (
    <div className={cn(catalogCardClassName, "cursor-default")}>
      <span className="absolute left-[10px] top-[10px] z-[2] rounded-full bg-[rgba(0,0,0,0.32)] px-2 py-[3px] text-[10px] font-bold uppercase tracking-[0.03em] text-white backdrop-blur-[6px]">
        {cardCornerLabel(item.instances)}
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
          {item.name}
        </div>
        <p className="mt-0.5 line-clamp-2 text-pretty text-[11px] text-text-3">
          {item.description === null ? "No description" : item.description}
        </p>
        {item.tools !== null && item.tools.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {item.tools.map((tool) => (
              <span
                key={tool}
                className="rounded-full bg-surface-2 px-1.5 py-[2px] text-[9.5px] text-text-3"
              >
                {tool}
              </span>
            ))}
          </div>
        )}
        <div className="mt-1.5 flex flex-col gap-1.5">
          {item.instances.length === 0 ? (
            <Badge tone="neutral">Not deployed</Badge>
          ) : (
            item.instances.map((instance) => (
              <InstanceRow key={instance.id} instance={instance} />
            ))
          )}
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

  const templatesQuery = useAgentTemplates();
  const instancesQuery = useAgentInstances(tenantId);

  const isLoading =
    meQuery.isLoading ||
    templatesQuery.isLoading ||
    (Boolean(tenantId) && instancesQuery.isLoading);
  const isError =
    meQuery.isError ||
    templatesQuery.isError ||
    instancesQuery.isError ||
    (!meQuery.isLoading && tenantId === null);

  const instancesByName = useMemo(() => {
    const map = new Map<string, AgentInstanceItem[]>();
    for (const instance of instancesQuery.data ?? []) {
      const existing = map.get(instance.name);
      if (existing) existing.push(instance);
      else map.set(instance.name, [instance]);
    }
    return map;
  }, [instancesQuery.data]);

  const definitionNames = useMemo(
    () => new Set((templatesQuery.data ?? []).map((t) => t.name)),
    [templatesQuery.data],
  );

  const hasDefinitions = (templatesQuery.data ?? []).length > 0;

  const filteredDefinitionItems = useMemo(() => {
    const definitions = templatesQuery.data ?? [];
    return filterAgentDefinitions(definitions, query).map(
      (definition): AgentCardItem => ({
        id: definition.key,
        name: definition.name,
        description: definition.description,
        tools: definition.tools,
        instances: instancesByName.get(definition.name) ?? [],
      }),
    );
  }, [query, templatesQuery.data, instancesByName]);

  const unmatchedInstanceItems = useMemo(() => {
    const unmatched = (instancesQuery.data ?? []).filter(
      (instance) => !definitionNames.has(instance.name),
    );
    return filterAgents(unmatched, query).map(
      (instance): AgentCardItem => ({
        id: instance.id,
        name: instance.name,
        description: instance.description,
        tools: null,
        instances: [instance],
      }),
    );
  }, [instancesQuery.data, definitionNames, query]);

  const isSearching = query.trim().length > 0;
  const totalVisible =
    filteredDefinitionItems.length + unmatchedInstanceItems.length;

  const columns: DataTableColumn<AgentCardItem>[] = [
    {
      key: "name",
      header: "Name",
      className: "font-medium text-text",
      render: (d) => d.name,
    },
    {
      key: "description",
      header: "Description",
      className: "max-w-[360px]",
      render: (d) => (
        <span className="line-clamp-1 text-text-3">
          {d.description === null ? "—" : d.description}
        </span>
      ),
    },
    {
      key: "tools",
      header: "Tools",
      render: (d) => (
        <span className="line-clamp-1 text-text-3">
          {d.tools === null || d.tools.length === 0
            ? "—"
            : d.tools.join(", ")}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (d) =>
        d.instances.length === 0 ? (
          <Badge tone="neutral">Not deployed</Badge>
        ) : (
          <div className="flex flex-col gap-1">
            {d.instances.map((instance) => (
              <Badge key={instance.id} tone={statusTone(instance.status)}>
                {statusLabel(instance.status)}
              </Badge>
            ))}
          </div>
        ),
    },
    {
      key: "address",
      header: "Address",
      render: (d) =>
        d.instances.length === 0 ? (
          <span className="text-text-3">—</span>
        ) : (
          <div className="flex flex-col gap-1">
            {d.instances.map((instance) => (
              <span
                key={instance.id}
                className="inline-flex max-w-full items-center gap-1"
              >
                <span className="min-w-0 truncate font-mono text-[12px]">
                  {instance.address}
                </span>
                <CopyAddressButton address={instance.address} />
              </span>
            ))}
          </div>
        ),
    },
  ];

  const pageChrome = useMemo(
    () => (
      <AppPageChromeRow title="Agents" count={totalVisible}>
        <LibrarySearchInput
          label="Search agents"
          placeholder="Search agents"
          value={query}
          onChange={setQuery}
        />
        <ViewToggle mode={viewMode} onChange={setViewMode} />
      </AppPageChromeRow>
    ),
    [totalVisible, query, viewMode, setViewMode],
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
        {!isLoading && !isError && !hasDefinitions && (
          <RichEmptyState
            icon={<Bot className="h-6 w-6" strokeWidth={1.75} />}
            title="No agent definitions yet"
            description="No agent definitions available yet."
          />
        )}
        {!isLoading &&
          !isError &&
          hasDefinitions &&
          totalVisible === 0 &&
          isSearching && (
            <div className="py-10 text-[13px] text-text-3">
              No results for &ldquo;{query.trim()}&rdquo;.
            </div>
          )}
        {!isLoading &&
          !isError &&
          hasDefinitions &&
          filteredDefinitionItems.length > 0 &&
          (viewMode === "rows" ? (
            <DataTable<AgentCardItem>
              caption="Agent definitions"
              rows={filteredDefinitionItems}
              getRowKey={(d) => d.id}
              columns={columns}
            />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-[var(--gap)] sm:grid-cols-[repeat(auto-fill,minmax(190px,1fr))]">
              {filteredDefinitionItems.map((item, i) => (
                <AgentCard key={item.id} item={item} index={i + 1} />
              ))}
            </div>
          ))}
        {!isLoading && !isError && unmatchedInstanceItems.length > 0 && (
          <div className="mt-8">
            <h2 className="mb-2 text-[13px] font-semibold text-text-2">
              Deployed instances
            </h2>
            {viewMode === "rows" ? (
              <DataTable<AgentCardItem>
                caption="Deployed instances"
                rows={unmatchedInstanceItems}
                getRowKey={(d) => d.id}
                columns={columns}
              />
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-[var(--gap)] sm:grid-cols-[repeat(auto-fill,minmax(190px,1fr))]">
                {unmatchedInstanceItems.map((item, i) => (
                  <AgentCard
                    key={item.id}
                    item={item}
                    index={filteredDefinitionItems.length + i + 1}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </PagePanel>
  );
}
