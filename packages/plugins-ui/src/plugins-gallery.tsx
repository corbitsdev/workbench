// The Plugins gallery (CL-6090): Plugins | Skills tabs over one search box,
// an installed strip, and a Featured-then-category card grid. Presentational
// — every list arrives already loaded; the composing page (`apps/web`'s
// `plugins-page.tsx`) owns fetching `listPluginsForTenant` and the skill
// registry, the same split every other package in this repo draws between
// "owns the domain" and "stays generic."

import { EmptyState, LibrarySearchInput, Tabs } from "@corbits/react-ui";
import type { ResolvedPlugin } from "@workbench/connections/plugins";
import { PackageSearch, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";

import { InstalledStrip } from "./installed-strip";
import { McpServersSection } from "./mcp-servers-section";
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

function PluginGrid({
  plugins,
  onOpen,
}: {
  readonly plugins: readonly ResolvedPlugin[];
  readonly onOpen: (plugin: ResolvedPlugin) => void;
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
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
  const filtered = plugins.filter((plugin) =>
    matchesQuery(
      [plugin.descriptor.displayName, pluginCategory(plugin.descriptor.id)],
      query,
    ),
  );

  if (plugins.length === 0) {
    return (
      <EmptyState
        icon={<PackageSearch />}
        title="No plugins registered"
        description="Nothing is available to connect yet."
      />
    );
  }

  if (filtered.length === 0) {
    return (
      <EmptyState
        icon={<PackageSearch />}
        title="Nothing matches"
        description={`No plugin matches "${query.trim()}".`}
      />
    );
  }

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
        icon={<Sparkles />}
        title="No skills yet"
        description="A skill is a named, reusable capability an agent can pin. Write one and it shows up here."
      />
    );
  }

  if (filtered.length === 0) {
    return (
      <EmptyState
        icon={<Sparkles />}
        title="Nothing matches"
        description={`No skill matches "${query.trim()}".`}
      />
    );
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
      {filtered.map((skill) => (
        <SkillCard
          key={skill.assetId}
          skill={skill}
          onOpen={() => onOpen(skill)}
        />
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
  autoOpenMcpAdd = false,
}: {
  readonly tenantId: string;
  readonly plugins: readonly ResolvedPlugin[];
  readonly skills: readonly SkillCardData[];
  readonly onOpenPlugin: (plugin: ResolvedPlugin) => void;
  readonly onOpenSkill: (skill: SkillCardData) => void;
  readonly autoOpenMcpAdd?: boolean;
}) {
  const [tab, setTab] = useState<PluginsGalleryTab>("plugins");
  const [query, setQuery] = useState("");

  const tabs = useMemo(
    () => [
      { id: "plugins" as const, label: "Plugins", count: plugins.length },
      { id: "skills" as const, label: "Skills", count: skills.length },
    ],
    [plugins.length, skills.length],
  );

  return (
    <div className="flex flex-col gap-4">
      <Tabs
        tabs={tabs}
        active={tab}
        onChange={setTab}
        label="Plugins gallery sections"
      >
        {(active) => (
          <div className="flex flex-col gap-4 pt-3">
            <div className="flex flex-wrap items-center gap-3">
              <LibrarySearchInput
                label={
                  active === "plugins" ? "Search plugins" : "Search skills"
                }
                value={query}
                onChange={setQuery}
              />
            </div>
            {active === "plugins" ? (
              <>
                <InstalledStrip plugins={plugins} onOpen={onOpenPlugin} />
                <McpServersSection
                  tenantId={tenantId}
                  autoOpenAdd={autoOpenMcpAdd}
                />
                <PluginsTabPanel
                  plugins={plugins}
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
