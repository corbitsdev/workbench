// The Plugins gallery (CL-6090): Plugins | Skills tabs over compact,
// categorized directory grids. Search is controlled by the composing page so
// it can live in the shared top bar. Presentational
// — every list arrives already loaded; the composing page (`apps/web`'s
// `plugins-page.tsx`) owns fetching `listPluginsForTenant` and the skill
// registry, the same split every other package in this repo draws between
// "owns the domain" and "stays generic."

import { EmptyState, Tabs } from "@corbits/react-ui";
import type { ResolvedPlugin } from "@workbench/connections/plugins";
import {
  MCP_PRESETS,
  MCP_PRESET_CONNECTOR_IDS,
} from "@workbench/connections/mcp-presets";
import { Lightning } from "@corbits/icons";
import { useMemo } from "react";

import { McpServersSection } from "./mcp-servers-section";
import { McpPresetCardsSection } from "./mcp-preset-cards";
import {
  FEATURED_CONNECTOR_IDS,
  PLUGIN_CATEGORY_ORDER,
  pluginCategory,
} from "./plugin-meta";
import { PluginCard } from "./plugin-card";
import { SkillCard, type SkillCardData } from "./skill-card";

export type PluginsGalleryTab = "plugins" | "skills";

function matchesQuery(haystacks: readonly string[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return haystacks.some((value) => value.toLowerCase().includes(needle));
}

function isConnectedLegacyPlugin(plugin: ResolvedPlugin): boolean {
  return plugin.status !== "not_connected";
}

function PluginGrid({
  plugins,
  onOpen,
}: {
  readonly plugins: readonly ResolvedPlugin[];
  readonly onOpen: (plugin: ResolvedPlugin) => void;
}) {
  return (
    <div className="border border-border [&>*:last-child]:border-b-0">
      {plugins.map((plugin) => (
        <PluginCard
          key={plugin.descriptor.id}
          plugin={plugin}
          onOpen={() => onOpen(plugin)}
        />
      ))}
    </div>
  );
}

function PluginsTabPanel({
  plugins,
  query,
  onOpen,
}: {
  readonly plugins: readonly ResolvedPlugin[];
  readonly query: string;
  readonly onOpen: (plugin: ResolvedPlugin) => void;
}) {
  const nonPreset = plugins.filter(
    (plugin) =>
      !MCP_PRESET_CONNECTOR_IDS.includes(plugin.descriptor.id) &&
      isConnectedLegacyPlugin(plugin),
  );
  const filtered = nonPreset.filter((plugin) =>
    matchesQuery(
      [plugin.descriptor.displayName, pluginCategory(plugin.descriptor.id)],
      query,
    ),
  );

  if (filtered.length === 0) return null;

  const showFeatured = query.trim() === "";
  const featured = showFeatured
    ? filtered.filter((plugin) =>
        FEATURED_CONNECTOR_IDS.includes(plugin.descriptor.id),
      )
    : [];
  const rest = showFeatured
    ? filtered.filter(
        (plugin) => !FEATURED_CONNECTOR_IDS.includes(plugin.descriptor.id),
      )
    : filtered;

  const byCategory = PLUGIN_CATEGORY_ORDER.map((category) => ({
    category,
    plugins: rest.filter(
      (plugin) => pluginCategory(plugin.descriptor.id) === category,
    ),
  })).filter((group) => group.plugins.length > 0);

  return (
    <div className="flex flex-col gap-6">
      {featured.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Featured
          </h3>
          <PluginGrid plugins={featured} onOpen={onOpen} />
        </section>
      ) : null}
      {byCategory.map((group) => (
        <section key={group.category} className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {group.category}
          </h3>
          <PluginGrid plugins={group.plugins} onOpen={onOpen} />
        </section>
      ))}
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
}: {
  readonly tenantId: string;
  readonly plugins: readonly ResolvedPlugin[];
  readonly skills: readonly SkillCardData[];
  readonly onOpenPlugin: (plugin: ResolvedPlugin) => void;
  readonly onOpenSkill: (skill: SkillCardData) => void;
  readonly activeTab: PluginsGalleryTab;
  readonly onTabChange: (tab: PluginsGalleryTab) => void;
  readonly query: string;
}) {
  // An inference-provider connector names no tool package it feeds
  // (`feedsTools: []`) — providers live only in Shared Settings'
  // Connections section, never in this directory (CL-6272.2).
  const installablePlugins = useMemo(
    () => plugins.filter((plugin) => plugin.descriptor.feedsTools.length > 0),
    [plugins],
  );

  const tabs = useMemo(
    () => [
      {
        id: "plugins" as const,
        label: "Plugins",
        count:
          installablePlugins.filter(
            (plugin) =>
              !MCP_PRESET_CONNECTOR_IDS.includes(plugin.descriptor.id) &&
              isConnectedLegacyPlugin(plugin),
          ).length + MCP_PRESETS.length,
      },
      { id: "skills" as const, label: "Skills", count: skills.length },
    ],
    [installablePlugins.length, skills.length],
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
                <McpPresetCardsSection tenantId={tenantId} query={query} />
                <McpServersSection tenantId={tenantId} />
                <PluginsTabPanel
                  plugins={installablePlugins}
                  query={query}
                  onOpen={onOpenPlugin}
                />
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
