import { useEffect, useMemo, useState } from "react";

import { Lightning } from "@corbits/icons";
import { EmptyState, FilterChip, Tabs } from "@corbits/react-ui";
import type { ConnectorDescriptor } from "@corbits/connections/registry";
import type { ResolvedPlugin } from "@corbits/connections/plugins";
import {
  MCP_PRESETS,
  MCP_PRESET_CONNECTOR_IDS,
} from "@workbench/templates/connectors";

import { McpServersSection } from "./mcp-servers-section";
import { McpPresetCard, useMcpPresetCatalog } from "./mcp-preset-cards";
import type { McpPreset } from "./mcp-servers-api";
import {
  pluginCatalogCategory,
  type PluginCatalogCategory,
  pluginOutcome,
} from "./plugin-meta";
import { PluginCard } from "./plugin-card";
import { SkillCard, type SkillCardData } from "./skill-card";

export type PluginsGalleryTab = "plugins" | "skills";
type PluginCatalogFilter = "all" | "connected" | PluginCatalogCategory;

type PluginCatalogEntry =
  | {
      readonly kind: "preset";
      readonly id: string;
      readonly name: string;
      readonly outcome: string;
      readonly category: PluginCatalogCategory | undefined;
      readonly connected: boolean;
      readonly preset: McpPreset;
    }
  | {
      readonly kind: "native";
      readonly id: string;
      readonly name: string;
      readonly outcome: string;
      readonly category: PluginCatalogCategory | undefined;
      readonly connected: boolean;
      readonly plugin: ResolvedPlugin;
    };

const PLUGIN_FILTERS = [
  { id: "all", label: "All" },
  { id: "connected", label: "Connected" },
  { id: "work", label: "Work" },
  { id: "developer", label: "Developer" },
  { id: "research", label: "Research" },
] satisfies readonly {
  readonly id: PluginCatalogFilter;
  readonly label: string;
}[];

const CATEGORY_LABELS: Record<PluginCatalogCategory, string> = {
  work: "Work",
  developer: "Developer",
  research: "Research",
};

const MCP_PRESET_CATALOG_IDS = new Set([
  ...MCP_PRESETS.map((preset) => preset.slug),
  ...MCP_PRESET_CONNECTOR_IDS,
]);

export function isNativePluginCatalogDescriptor(
  descriptor: ConnectorDescriptor,
): boolean {
  return (
    descriptor.feedsTools.length > 0 &&
    !MCP_PRESET_CATALOG_IDS.has(descriptor.id)
  );
}

function matchesQuery(haystacks: readonly string[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return haystacks.some((value) => value.toLowerCase().includes(needle));
}

function matchesFilter(
  entry: PluginCatalogEntry,
  filter: PluginCatalogFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "connected") return entry.connected;
  return entry.category === filter;
}

function PluginFilterBar({
  entries,
  active,
  onChange,
}: {
  readonly entries: readonly PluginCatalogEntry[];
  readonly active: PluginCatalogFilter;
  readonly onChange: (filter: PluginCatalogFilter) => void;
}) {
  return (
    <div
      className="flex flex-wrap gap-2"
      role="group"
      aria-label="Plugin catalog filters"
    >
      {PLUGIN_FILTERS.map((filter) => (
        <FilterChip
          key={filter.id}
          selected={active === filter.id}
          count={
            entries.filter((entry) => matchesFilter(entry, filter.id)).length
          }
          onClick={() => onChange(filter.id)}
        >
          {filter.label}
        </FilterChip>
      ))}
    </div>
  );
}

function PluginCatalogPanel({
  tenantId,
  entries,
  query,
  activeFilter,
  onFilterChange,
  toolCounts,
  onPresetChanged,
  onOpenPlugin,
}: {
  readonly tenantId: string;
  readonly entries: readonly PluginCatalogEntry[];
  readonly query: string;
  readonly activeFilter: PluginCatalogFilter;
  readonly onFilterChange: (filter: PluginCatalogFilter) => void;
  readonly toolCounts: ReadonlyMap<string, number>;
  readonly onPresetChanged: (
    slug: string,
    toolCount: number | undefined,
  ) => void;
  readonly onOpenPlugin: (plugin: ResolvedPlugin) => void;
}) {
  const queryMatches = entries.filter((entry) =>
    matchesQuery(
      [
        entry.name,
        entry.outcome,
        ...(entry.category === undefined
          ? []
          : [CATEGORY_LABELS[entry.category]]),
      ],
      query,
    ),
  );
  const visibleEntries = queryMatches.filter((entry) =>
    matchesFilter(entry, activeFilter),
  );

  return (
    <div className="flex flex-col gap-4">
      <PluginFilterBar
        entries={queryMatches}
        active={activeFilter}
        onChange={onFilterChange}
      />
      {visibleEntries.length === 0 ? (
        <EmptyState
          icon={<Lightning />}
          title="Nothing matches"
          description={
            query.trim() === ""
              ? "No plugins are available in this filter."
              : `No plugin matches "${query.trim()}" in this filter.`
          }
        />
      ) : null}
      {visibleEntries.length > 0 ? (
        <div className="plugins-catalog-grid" aria-label="Plugin catalog">
          {visibleEntries.map((entry) =>
            entry.kind === "preset" ? (
              <McpPresetCard
                key={`preset:${entry.id}`}
                tenantId={tenantId}
                preset={entry.preset}
                toolCount={toolCounts.get(entry.id)}
                onChanged={(toolCount) => onPresetChanged(entry.id, toolCount)}
              />
            ) : (
              <PluginCard
                key={`native:${entry.id}`}
                plugin={entry.plugin}
                onOpen={() => onOpenPlugin(entry.plugin)}
              />
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function SkillsTabPanel({
  skills,
  query,
  onOpen,
}: {
  readonly skills: readonly SkillCardData[];
  readonly query: string;
  readonly onOpen: (skill: SkillCardData) => void;
}) {
  const filtered = skills.filter((skill) =>
    matchesQuery([skill.name, skill.description], query),
  );

  if (skills.length === 0) {
    return (
      <EmptyState
        icon={<Lightning />}
        title="No skills yet"
        description="A skill is a named, reusable capability an agent can pin. Write one and it shows up here."
      />
    );
  }

  if (filtered.length === 0) {
    return (
      <EmptyState
        icon={<Lightning />}
        title="Nothing matches"
        description={`No skill matches "${query.trim()}".`}
      />
    );
  }

  const groups = [
    {
      label: "Shared with everyone",
      skills: filtered.filter((skill) => skill.scope === "tenant"),
    },
    {
      label: "Just you",
      skills: filtered.filter((skill) => skill.scope === "private"),
    },
  ].filter((group) => group.skills.length > 0);

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <section key={group.label} className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {group.label}
          </h3>
          <div className="border border-border [&>*:last-child]:border-b-0">
            {group.skills.map((skill) => (
              <SkillCard
                key={skill.assetId}
                skill={skill}
                onOpen={() => onOpen(skill)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function PluginsGallery({
  tenantId,
  plugins,
  skills,
  onOpenPlugin,
  onOpenSkill,
  activeTab,
  onTabChange,
  query,
  autoConnectPresetSlug = null,
  onAutoConnectPresetHandled,
}: {
  readonly tenantId: string;
  readonly plugins: readonly ResolvedPlugin[];
  readonly skills: readonly SkillCardData[];
  readonly onOpenPlugin: (plugin: ResolvedPlugin) => void;
  readonly onOpenSkill: (skill: SkillCardData) => void;
  readonly activeTab: PluginsGalleryTab;
  readonly onTabChange: (tab: PluginsGalleryTab) => void;
  readonly query: string;
  /** A curated MCP preset's slug named by a `/plugins?connect=mcp:<slug>`
   * deep link (CL-7141) — passed through to the presets section so it can
   * focus that preset's own card once its catalog has loaded. */
  readonly autoConnectPresetSlug?: string | null;
  readonly onAutoConnectPresetHandled?: () => void;
}) {
  const [activeFilter, setActiveFilter] = useState<PluginCatalogFilter>("all");
  const presetCatalog = useMcpPresetCatalog(tenantId);

  const nativeEntries = useMemo<readonly PluginCatalogEntry[]>(
    () =>
      plugins
        .filter((plugin) => isNativePluginCatalogDescriptor(plugin.descriptor))
        .map((plugin) => ({
          kind: "native",
          id: plugin.descriptor.id,
          name: plugin.descriptor.displayName,
          outcome: pluginOutcome(
            plugin.descriptor.id,
            plugin.descriptor.displayName,
          ),
          category: pluginCatalogCategory(plugin.descriptor.id),
          connected: plugin.status !== "not_connected",
          plugin,
        })),
    [plugins],
  );
  const catalogEntries = useMemo<readonly PluginCatalogEntry[]>(
    () => [
      ...presetCatalog.presets.map((preset) => ({
        kind: "preset" as const,
        id: preset.slug,
        name: preset.displayName,
        outcome: preset.description,
        category: pluginCatalogCategory(preset.slug),
        connected: preset.connected,
        preset,
      })),
      ...nativeEntries,
    ],
    [nativeEntries, presetCatalog.presets],
  );

  useEffect(() => {
    if (!presetCatalog.loaded || autoConnectPresetSlug === null) return;
    const row = Array.from(
      document.querySelectorAll<HTMLElement>("[data-plugin-slug]"),
    ).find((element) => element.dataset.pluginSlug === autoConnectPresetSlug);
    row?.querySelector<HTMLButtonElement>("button")?.focus();
    onAutoConnectPresetHandled?.();
  }, [
    autoConnectPresetSlug,
    onAutoConnectPresetHandled,
    presetCatalog.loaded,
    presetCatalog.presets,
  ]);

  const tabs = useMemo(
    () => [
      {
        id: "plugins" as const,
        label: "Plugins",
        count:
          nativeEntries.length +
          (presetCatalog.loaded
            ? presetCatalog.presets.length
            : MCP_PRESETS.length),
      },
      { id: "skills" as const, label: "Skills", count: skills.length },
    ],
    [
      nativeEntries.length,
      presetCatalog.loaded,
      presetCatalog.presets.length,
      skills.length,
    ],
  );

  return (
    <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-4">
      <Tabs
        tabs={tabs}
        active={activeTab}
        onChange={onTabChange}
        label="Plugins gallery sections"
      >
        {(active) => (
          <div className="flex flex-col gap-4 pt-3">
            {active === "plugins" ? (
              <>
                {presetCatalog.loadError !== null ? (
                  <p className="text-sm text-destructive" role="alert">
                    {presetCatalog.loadError}
                  </p>
                ) : null}
                {!presetCatalog.loaded ? (
                  <p className="text-sm text-muted-foreground" role="status">
                    Loading plugins…
                  </p>
                ) : (
                  <PluginCatalogPanel
                    tenantId={tenantId}
                    entries={catalogEntries}
                    query={query}
                    activeFilter={activeFilter}
                    onFilterChange={setActiveFilter}
                    toolCounts={presetCatalog.toolCounts}
                    onPresetChanged={presetCatalog.handleChanged}
                    onOpenPlugin={onOpenPlugin}
                  />
                )}
                <McpServersSection tenantId={tenantId} />
              </>
            ) : (
              <SkillsTabPanel
                skills={skills}
                query={query}
                onOpen={onOpenSkill}
              />
            )}
          </div>
        )}
      </Tabs>
    </div>
  );
}
