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
// not the Skills roster's list rows. Opening a card (or creating a skill)
// navigates to `/skills/<name>` — the same path `SkillsPage.open` already
// uses. Mutations live there; this gallery never mounts a twin editor.

import { Button, PageShell, RichEmptyState } from "@corbits/react-ui";
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
import { SKILLS_PATH_PREFIX } from "../path-ids";
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
  navigate,
}: {
  readonly path: string;
  readonly navigate: (to: string) => void;
}) {
  const { selectedTenantId } = useBench();
  const [pluginsState, setPluginsState] = useState<PluginsState>({
    status: "loading",
  });
  const [skillsState, setSkillsState] = useState<SkillsState>({
    status: "loading",
  });
  const [openPlugin, setOpenPlugin] = useState<ResolvedPlugin | null>(null);
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

  const [pluginsReloadKey, setPluginsReloadKey] = useState(0);
  const [skillsReloadKey, setSkillsReloadKey] = useState(0);

  const reloadPlugins = useCallback(() => {
    setPluginsReloadKey((key) => key + 1);
  }, []);

  const reloadSkills = useCallback(() => {
    setSkillsReloadKey((key) => key + 1);
  }, []);

  // Guarded by `cancelled` (same pattern as settings-ui's `people-section`)
  // so a tenant switch mid-flight can't have the previous tenant's late
  // response overwrite the newly selected tenant's state.
  useEffect(() => {
    if (selectedTenantId === null) return;
    let cancelled = false;
    setPluginsState({ status: "loading" });
    listPluginsForTenant(selectedTenantId)
      .then((plugins) => {
        if (!cancelled) setPluginsState({ status: "ready", plugins });
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setPluginsState({ status: "error", message: messageOf(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTenantId, pluginsReloadKey]);

  useEffect(() => {
    if (selectedTenantId === null) return;
    let cancelled = false;
    setSkillsState({ status: "loading" });
    listSkills(selectedTenantId)
      .then((skills) => {
        if (!cancelled) setSkillsState({ status: "ready", skills });
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setSkillsState({ status: "error", message: messageOf(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTenantId, skillsReloadKey]);

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

  function openSkill(name: string) {
    navigate(`${SKILLS_PATH_PREFIX}/${encodeURIComponent(name)}`);
  }

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
    openSkill(skill.name);
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
        filter={{
          label: activeTab === "plugins" ? "Filter plugins" : "Filter skills",
          value: galleryQuery,
          onChange: setGalleryQuery,
        }}
        actions={
          activeTab === "skills" ? (
            <Button size="sm" onClick={() => setCreateSkillOpen(true)}>
              <Plus /> New skill
            </Button>
          ) : null
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
          onOpenSkill={(skill) => openSkill(skill.name)}
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
      <CreateSkillDialog
        open={createSkillOpen}
        onOpenChange={setCreateSkillOpen}
        onSubmit={handleCreateSkill}
      />
    </div>
  );
}
