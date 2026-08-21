// The Plugins gallery route (CL-6090) — a thin composition, same shape as
// `library-page.tsx`: page-level data fetching and wiring live here,
// presentation lives in `@corbits/plugins-ui`. This page reads the
// currently selected bench tenant the same way every other Settings
// surface does (`useBench().selectedTenantId`) — the owner's "PARENT
// (account/root) tenant" framing maps onto whichever tenant that is: the
// app has no separate "account" tenant type above a bench today, and this
// page's own data is always that tenant's OWN plugin connections plus
// whatever it inherits from its ancestors, exactly like every other
// Connections surface. See this ticket's report for the full grounding.
//
// Skills gets the same gallery treatment as plugins (owner ruling): cards,
// not the Settings section's list rows — reusing `../skills-api.ts`'s data
// and mutations through `PluginSkillDetailPanel`, never forking
// `SkillsPage` itself.

import {
  Button,
  LibrarySearchInput,
  PageShell,
  RichEmptyState,
} from "@corbits/react-ui";
import { WorkbenchLoadingState } from "@corbits/chat-ui";
import {
  PluginsGallery,
  PluginConnectPanel,
  type PluginsGalleryTab,
} from "@corbits/plugins-ui";
import type { ResolvedPlugin } from "@workbench/connections/plugins";
import { listPluginsForTenant } from "@workbench/connections/plugins";
import { Plus, SquaresFour, Warning } from "@corbits/icons";
import { useCallback, useEffect, useState } from "react";

import { useBench } from "../bench-context";
import {
  useClearPendingConnectProvider,
  usePendingConnectProvider,
} from "../shell/provider-health-context";
import { StageTopBar } from "../shell/stage-top-bar";
import {
  createSkill,
  createSkillFromFile,
  listSkills,
  type SkillSummary,
} from "../skills-api";
import {
  CreateSkillDialog,
  type SkillCreateInput,
} from "./create-skill-dialog";
import { PluginSkillDetailPanel } from "./plugin-skill-detail-panel";

type PluginsState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly plugins: readonly ResolvedPlugin[] }
  | { readonly status: "error"; readonly message: string };

type SkillsState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly skills: readonly SkillSummary[] }
  | { readonly status: "error"; readonly message: string };

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function canOpenPluginPanel(plugin: ResolvedPlugin): boolean {
  return plugin.status !== "not_connected";
}

export function PluginsRoute({
  path: _path,
}: {
  readonly path: string;
  readonly navigate?: (to: string) => void;
}) {
  const { selectedTenantId } = useBench();
  const [pluginsState, setPluginsState] = useState<PluginsState>({
    status: "loading",
  });
  const [skillsState, setSkillsState] = useState<SkillsState>({
    status: "loading",
  });
  const [openPlugin, setOpenPlugin] = useState<ResolvedPlugin | null>(null);
  const [openSkillName, setOpenSkillName] = useState<string | null>(null);
  const [createSkillOpen, setCreateSkillOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<PluginsGalleryTab>("plugins");
  const [galleryQuery, setGalleryQuery] = useState("");
  // Set when the shell banner's "Fix it" deep link named a provider this
  // gallery has no matching card for (CL-6092) — rather than the deep
  // link silently no-oping, this renders a notice pointing back at the
  // gallery itself.
  const [connectDeepLinkNotFound, setConnectDeepLinkNotFound] = useState(false);
  const pendingConnectProvider = usePendingConnectProvider();
  const clearPendingConnectProvider = useClearPendingConnectProvider();
  const openPluginPanel = useCallback((plugin: ResolvedPlugin) => {
    setOpenPlugin(plugin);
    setConnectDeepLinkNotFound(false);
  }, []);

  const reloadPlugins = useCallback(() => {
    if (selectedTenantId === null) return;
    listPluginsForTenant(selectedTenantId)
      .then((plugins) => setPluginsState({ status: "ready", plugins }))
      .catch((cause: unknown) =>
        setPluginsState({ status: "error", message: messageOf(cause) }),
      );
  }, [selectedTenantId]);

  const reloadSkills = useCallback(() => {
    if (selectedTenantId === null) return;
    listSkills(selectedTenantId)
      .then((skills) => setSkillsState({ status: "ready", skills }))
      .catch((cause: unknown) =>
        setSkillsState({ status: "error", message: messageOf(cause) }),
      );
  }, [selectedTenantId]);

  useEffect(() => {
    setPluginsState({ status: "loading" });
    reloadPlugins();
  }, [reloadPlugins]);

  useEffect(() => {
    setSkillsState({ status: "loading" });
    reloadSkills();
  }, [reloadSkills]);

  // The shell banner's "Fix it" deep link (CL-6092): once the gallery has
  // loaded, pick up any pending provider id and open its connect panel —
  // the same panel a gallery card click opens, so a person lands exactly
  // where they would have clicked themselves.
  useEffect(() => {
    if (pluginsState.status !== "ready") return;
    if (pendingConnectProvider === null) return;
    const match = pluginsState.plugins.find(
      (plugin) => plugin.descriptor.id === pendingConnectProvider,
    );
    if (match !== undefined && canOpenPluginPanel(match)) {
      openPluginPanel(match);
    } else {
      setConnectDeepLinkNotFound(true);
    }
    clearPendingConnectProvider();
  }, [
    pluginsState,
    pendingConnectProvider,
    clearPendingConnectProvider,
    openPluginPanel,
  ]);

  async function handleCreateSkill(input: SkillCreateInput) {
    if (selectedTenantId === null) return;
    const skill =
      input.kind === "file"
        ? await createSkillFromFile(selectedTenantId, input.source)
        : await createSkill(selectedTenantId, {
            name: input.name,
            description: input.description,
            body: input.body,
          });
    setCreateSkillOpen(false);
    reloadSkills();
    setOpenSkillName(skill.name);
  }

  if (selectedTenantId === null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Plugins" }]} />
        <PageShell width="full" className="page-fill">
          <RichEmptyState
            icon={<SquaresFour />}
            title="Select a workbench"
            description="Open a workbench to see its plugins."
          />
        </PageShell>
      </div>
    );
  }

  const tenantId = selectedTenantId;

  if (pluginsState.status === "error" || skillsState.status === "error") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Plugins" }]} />
        <PageShell width="full" className="page-fill">
          <RichEmptyState
            icon={<SquaresFour />}
            title="Couldn't load your plugins"
            description="Something went wrong on our side. Try again in a moment."
            actions={[
              {
                label: "Retry",
                onClick: () => {
                  reloadPlugins();
                  reloadSkills();
                },
              },
            ]}
          />
        </PageShell>
      </div>
    );
  }

  if (pluginsState.status === "loading" || skillsState.status === "loading") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Plugins" }]} />
        <PageShell width="full" className="page-fill">
          <WorkbenchLoadingState title="Loading plugins…" />
        </PageShell>
      </div>
    );
  }

  const skillCards = skillsState.skills.map((skill) => ({
    assetId: skill.assetId,
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
  }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[{ label: "Plugins" }]}
        actions={
          <>
            <LibrarySearchInput
              label={
                activeTab === "plugins" ? "Search plugins" : "Search skills"
              }
              value={galleryQuery}
              onChange={setGalleryQuery}
            />
            {activeTab === "skills" ? (
              <Button size="sm" onClick={() => setCreateSkillOpen(true)}>
                <Plus /> New skill
              </Button>
            ) : null}
          </>
        }
      />
      <PageShell width="full" className="page-fill">
        {connectDeepLinkNotFound ? (
          <div className="plugins-connect-notice" role="status">
            <Warning className="plugins-connect-notice-icon" aria-hidden />
            <p className="plugins-connect-notice-text">
              Couldn't find that connection — pick it below.
            </p>
          </div>
        ) : null}
        <PluginsGallery
          tenantId={tenantId}
          plugins={pluginsState.plugins}
          skills={skillCards}
          onOpenPlugin={openPluginPanel}
          onOpenSkill={(skill) => setOpenSkillName(skill.name)}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          query={galleryQuery}
        />
      </PageShell>
      <PluginConnectPanel
        tenantId={tenantId}
        plugin={openPlugin}
        onClose={() => setOpenPlugin(null)}
        onChanged={reloadPlugins}
      />
      <PluginSkillDetailPanel
        tenantId={tenantId}
        skillName={openSkillName}
        onClose={() => setOpenSkillName(null)}
        onChanged={reloadSkills}
      />
      <CreateSkillDialog
        open={createSkillOpen}
        onOpenChange={setCreateSkillOpen}
        onSubmit={handleCreateSkill}
      />
    </div>
  );
}
