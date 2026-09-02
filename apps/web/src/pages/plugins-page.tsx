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
import type { ResolvedPlugin } from "@corbits/connections/plugins";
import { listPluginsForTenant } from "@corbits/connections/plugins";
import {
  CONNECTOR_REGISTRY,
  MCP_PRESETS,
} from "@workbench/templates/connectors";
import { Plus, SquaresFour, Warning } from "@corbits/icons";
import { useCallback, useEffect, useRef, useState } from "react";

import { useBench } from "../bench-context";
import { SKILLS_PATH_PREFIX } from "../path-ids";
import {
  useClearPendingConnectProvider,
  usePendingConnectProvider,
  useRequestPluginsConnect,
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
  // A preset deep link's slug (CL-7141), passed to the MCP presets
  // section so it can focus that preset's own card once its catalog
  // has loaded — cleared as soon as the section has acted on it.
  const [autoConnectPresetSlug, setAutoConnectPresetSlug] = useState<
    string | null
  >(null);
  const pendingConnectProvider = usePendingConnectProvider();
  const clearPendingConnectProvider = useClearPendingConnectProvider();
  const requestPluginsConnect = useRequestPluginsConnect();
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
  // response overwrite the newly selected tenant's state. The loading
  // skeleton only shows for a tenant this page hasn't fetched yet — an
  // imperative reload (a connect/disconnect's `onChanged`, the error
  // screen's Retry) keeps whatever is already on screen and swaps in the
  // fresh data once it lands, the same way it worked before cancellation
  // was added.
  const pluginsLoadedTenantRef = useRef<string | null>(null);
  const skillsLoadedTenantRef = useRef<string | null>(null);

  useEffect(() => {
    if (selectedTenantId === null) return;
    let cancelled = false;
    const isTenantChange = pluginsLoadedTenantRef.current !== selectedTenantId;
    pluginsLoadedTenantRef.current = selectedTenantId;
    if (isTenantChange) setPluginsState({ status: "loading" });
    listPluginsForTenant(selectedTenantId, CONNECTOR_REGISTRY)
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

  // Keep plugin connection status live while the gallery sits open —
  // a credential expiring or a disconnect in another tab/window would
  // otherwise leave "Connected" stale indefinitely. Re-read on
  // visibility/focus and poll every 30s while visible, mirroring the
  // pattern `ConnectionsSection` and the `subscribeConnectState` containers
  // use for in-room connect cards.
  useEffect(() => {
    if (selectedTenantId === null) return;
    const refresh = () => {
      if (document.visibilityState === "visible") {
        setPluginsReloadKey((key) => key + 1);
      }
    };
    const onFocus = () => setPluginsReloadKey((key) => key + 1);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", onFocus);
    const interval = setInterval(refresh, 30_000);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", onFocus);
      clearInterval(interval);
    };
  }, [selectedTenantId]);

  useEffect(() => {
    if (selectedTenantId === null) return;
    let cancelled = false;
    const isTenantChange = skillsLoadedTenantRef.current !== selectedTenantId;
    skillsLoadedTenantRef.current = selectedTenantId;
    if (isTenantChange) setSkillsState({ status: "loading" });
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

  // `request_connection`'s fallback link (CL-7141): `/plugins?connect=<id>`
  // hands the connector id off through the same `requestPluginsConnect`
  // path the shell banner's "Fix it" click uses, then strips only the
  // `connect` param — any other query param this route is ever opened
  // with (e.g. an in-flight `mcpOauth` return) must survive the rewrite.
  // A curated MCP preset (Exa, Granola, Linear, ...) has no fixed
  // `CONNECTOR_REGISTRY` id, so its own deep link is `mcp:<slug>`
  // (`presetDeepLink` in `packages/connections-tools/src/tool.ts`) and
  // is matched against the preset catalog instead. An id neither side
  // recognizes (typo, stale link) is ignored rather than surfaced as a
  // notice.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connectId = params.get("connect");
    if (connectId === null) return;
    params.delete("connect");
    const rest = params.toString();
    window.history.replaceState(
      null,
      "",
      rest === ""
        ? window.location.pathname
        : `${window.location.pathname}?${rest}`,
    );
    if (connectId.startsWith("mcp:")) {
      const slug = connectId.slice("mcp:".length);
      if (MCP_PRESETS.some((preset) => preset.slug === slug)) {
        setAutoConnectPresetSlug(slug);
      }
      return;
    }
    if (CONNECTOR_REGISTRY[connectId] !== undefined) {
      requestPluginsConnect(connectId);
    }
  }, [requestPluginsConnect]);

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
          autoConnectPresetSlug={autoConnectPresetSlug}
          onAutoConnectPresetHandled={() => setAutoConnectPresetSlug(null)}
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
