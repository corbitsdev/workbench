import {
  CATALOG_GLYPH_FILLS,
  CATALOG_GLYPH_KINDS,
  catalogCardClassName,
  DataTable,
  hashString,
  LibraryPageHeader,
  LibrarySearchInput,
  PagePanel,
  toHumanLabel,
  useViewMode,
  ViewToggle,
  type DataTableColumn,
} from "@workbench/ui";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useToolsLibrary, type ToolSummary } from "../hooks/use-tools";
import { getMe } from "../lib/hub-api";
import { providerLabel } from "../lib/tool-providers";
import { ProviderLogo } from "../components/ProviderLogo";

interface ToolGroup {
  provider: string;
  label: string;
  tools: ToolSummary[];
}

function groupByProvider(tools: ToolSummary[]): ToolGroup[] {
  const groups = new Map<string, ToolGroup>();
  for (const tool of tools) {
    const existing = groups.get(tool.providerName);
    if (existing) {
      existing.tools.push(tool);
      continue;
    }
    groups.set(tool.providerName, {
      provider: tool.providerName,
      label: providerLabel(tool.providerName),
      tools: [tool],
    });
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function ToolCard({
  tool,
  index,
  onSelect,
}: {
  tool: ToolSummary;
  index: number;
  onSelect: () => void;
}) {
  // Group visuals by provider so tools from the same integration read as a set.
  const providerHash = hashString(tool.providerName);
  const glyph =
    CATALOG_GLYPH_KINDS[hashString(tool.name) % CATALOG_GLYPH_KINDS.length];
  const fill = CATALOG_GLYPH_FILLS[providerHash % CATALOG_GLYPH_FILLS.length];

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${tool.name}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={catalogCardClassName}
    >
      <span className="absolute left-[10px] top-[10px] z-[2] rounded-full bg-[rgba(0,0,0,0.32)] px-2 py-[3px] text-[10px] font-bold uppercase tracking-[0.03em] text-white backdrop-blur-[6px]">
        {tool.providerName}
      </span>
      <div
        className={`relative grid h-[112px] place-items-center overflow-hidden ${fill}`}
      >
        <ProviderLogo
          providerName={tool.providerName}
          fallbackGlyph={glyph}
          size={56}
        />
        <span className="absolute bottom-[10px] right-3 font-mono text-[13px] font-bold text-[rgba(255,255,255,0.85)]">
          T{index.toString().padStart(2, "0")}
        </span>
      </div>
      <div className="border-t border-border bg-surface px-[13px] py-[11px]">
        <div className="truncate text-[13px] font-semibold text-text">
          {toHumanLabel(tool.name)}
        </div>
        <p className="mt-0.5 line-clamp-2 text-pretty text-[11px] text-text-3">
          {tool.description || "No description"}
        </p>
        {tool.version !== null && (
          <span className="mt-1.5 block font-mono text-[10px] text-text-3/70">
            v{tool.version}
          </span>
        )}
      </div>
    </div>
  );
}

const ALL_PROVIDERS = "__all__";

const toolRowColumns: DataTableColumn<ToolSummary>[] = [
  {
    key: "name",
    header: "Name",
    className: "font-medium text-text",
    render: (t) => toHumanLabel(t.name),
  },
  {
    key: "provider",
    header: "Provider",
    render: (t) => t.providerName,
  },
  {
    key: "version",
    header: "Version",
    className: "font-mono",
    render: (t) => (t.version !== null ? `v${t.version}` : "—"),
  },
  {
    key: "description",
    header: "Description",
    className: "max-w-[420px]",
    render: (t) => (
      <span className="line-clamp-1 text-text-3">
        {t.description || "No description"}
      </span>
    ),
  },
];

export function ToolsLibrary() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<string>(ALL_PROVIDERS);
  const { mode: viewMode, setMode: setViewMode } = useViewMode("tools");
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: getMe,
    staleTime: 5 * 60_000,
  });
  const tenantId = meQuery.data?.personalTenantId ?? null;
  const toolsQuery = useToolsLibrary(tenantId);

  // Provider options come from the full catalog, not the search-filtered set,
  // so the dropdown stays stable while the user types.
  const providerOptions = useMemo(
    () =>
      groupByProvider(toolsQuery.data ?? []).map((g) => ({
        provider: g.provider,
        label: g.label,
      })),
    [toolsQuery.data],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (toolsQuery.data ?? []).filter(
      (tool) =>
        (provider === ALL_PROVIDERS || tool.providerName === provider) &&
        (!q ||
          tool.name.toLowerCase().includes(q) ||
          toHumanLabel(tool.name).toLowerCase().includes(q) ||
          tool.providerName.toLowerCase().includes(q) ||
          tool.description.toLowerCase().includes(q)),
    );
  }, [query, provider, toolsQuery.data]);

  const groups = useMemo(() => groupByProvider(filtered), [filtered]);

  // Tile numbering is continuous across groups so each tool keeps a stable index;
  // precompute it from the flat list so the group render stays a pure lookup.
  const toolIndices = useMemo(() => {
    const indices = new Map<string, number>();
    filtered.forEach((tool, i) => indices.set(tool.name, i + 1));
    return indices;
  }, [filtered]);

  const isSearching = query.trim().length > 0;
  const isFiltering = provider !== ALL_PROVIDERS;

  return (
    <PagePanel>
      <LibraryPageHeader title="Tools" count={filtered.length}>
        <select
          aria-label="Filter by provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="h-[34px] rounded-input border border-border bg-transparent px-[11px] text-[12.5px] text-text focus:border-border-strong focus:outline-none"
        >
          <option value={ALL_PROVIDERS}>All providers</option>
          {providerOptions.map((opt) => (
            <option key={opt.provider} value={opt.provider}>
              {opt.label}
            </option>
          ))}
        </select>
        <LibrarySearchInput
          label="Search tools"
          placeholder="Search tools"
          value={query}
          onChange={setQuery}
        />
        <ViewToggle mode={viewMode} onChange={setViewMode} />
      </LibraryPageHeader>

      <div className="flex-1 px-4 pb-10 pt-1.5 sm:px-7">
        {toolsQuery.isLoading && (
          <div className="py-10 text-[13px] text-text-3">Loading tools…</div>
        )}
        {toolsQuery.isError && (
          <div className="py-10 text-[13px] text-text-3">
            Could not load tools.
          </div>
        )}
        {!toolsQuery.isLoading &&
          !toolsQuery.isError &&
          filtered.length === 0 && (
            <div className="py-10 text-[13px] text-text-3">
              {isSearching || isFiltering ? (
                <>No tools match the current filters.</>
              ) : (
                <>No tools available.</>
              )}
            </div>
          )}
        {!toolsQuery.isLoading &&
          !toolsQuery.isError &&
          filtered.length > 0 &&
          (viewMode === "rows" ? (
            <DataTable<ToolSummary>
              caption="Tools"
              rows={filtered}
              getRowKey={(t) => t.name}
              onRowClick={(t) =>
                navigate(`/tools/${encodeURIComponent(t.name)}`)
              }
              columns={toolRowColumns}
            />
          ) : (
            <div className="flex flex-col gap-7">
              {groups.map((group) => (
                <section key={group.provider}>
                  <h2 className="mb-3 flex items-center gap-[9px] text-[13px] font-semibold uppercase tracking-[0.04em] text-text-2">
                    <ProviderLogo
                      providerName={group.provider}
                      size={18}
                      hideFallback
                    />
                    {group.label}
                    <span className="rounded-[6px] bg-surface-2 px-[7px] py-[2px] font-mono text-[11px] font-normal text-text-3">
                      {group.tools.length}
                    </span>
                  </h2>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-[var(--gap)] sm:grid-cols-[repeat(auto-fill,minmax(190px,1fr))]">
                    {group.tools.map((tool) => {
                      return (
                        <ToolCard
                          key={tool.name}
                          tool={tool}
                          index={toolIndices.get(tool.name) ?? 0}
                          onSelect={() =>
                            navigate(`/tools/${encodeURIComponent(tool.name)}`)
                          }
                        />
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          ))}
      </div>
    </PagePanel>
  );
}
