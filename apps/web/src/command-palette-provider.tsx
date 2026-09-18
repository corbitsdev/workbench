import { artifactKindLabel, CommandPalette, useCommandShortcut, useTheme } from "@corbits/react-ui";
import type { CommandPaletteGroup } from "@corbits/react-ui";
import { listWorkbenches } from "@/chat/workbench-tenants";
import { libraryArtifactPath } from "@/library";
import { reportError } from "@corbits/error-sink";
import {
  buildCommandPaletteGroups,
  buildStaticCommands,
  detailPath,
  isBareScopeQuery,
  parsePaletteQuery,
  useEntitySearch,
  type PaletteResultItem,
  type PaletteSource,
  type RecentEntry,
} from "@/command-palette";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { listChatAgents } from "@/chat/threads-api";
import { chatPath } from "./chat-path";
import { ACTION_COMMANDS, runActionCommand, type ActionCommandId } from "./command-palette-actions";
import {
  openCommandPalette,
  setCommandPaletteOpen,
  setCommandPaletteQuery,
  useCommandPaletteOpen,
  useCommandPaletteQuery,
} from "./command-palette-open-store";
import { WORKBENCH_NOT_FOUND_EVENT } from "./workbench-not-found-event";
import { recentsStoreForBench } from "./command-palette-recents";
import { NAV_ROUTES } from "./routes";
import { ArtifactListPageSchema, useAPIQuery } from "./api";
import { useBench } from "./bench-context";
import { useCloseCanvas } from "./shell/canvas-availability";
import { SKILLS_PATH_PREFIX } from "./path-ids";
import { listScheduledWorkflows, runScheduledWorkflowNow, useTenantQuery } from "./routines-api";
import { listSkills } from "./skills-api";
import { tenantKeys } from "./query-client";
import type { Navigate } from "./navigation";

const STATIC_COMMANDS = buildStaticCommands(
  NAV_ROUTES.map((route) => ({ path: route.path, label: route.label })),
);

// Mounted once above `AppShell` so it works from every route, including
// one that matches no page. Grouping/scope-parsing lives in
// `@/command-palette`; this file only assembles the app's own sources.
export function CommandPaletteProvider({
  path,
  navigate,
  children,
}: {
  readonly path: string;
  readonly navigate: Navigate;
  readonly children: ReactNode;
}) {
  const { benchMemberships, selectedTenantId, selectTenant } = useBench();
  const queryClient = useQueryClient();
  // Open state and query live in the shared store, not in this component:
  // Cmd+K and a context-menu item both open this surface from outside the
  // React tree (`command-palette-open-store`).
  const open = useCommandPaletteOpen();
  const query = useCommandPaletteQuery();
  const [recents, setRecents] = useState<readonly RecentEntry[]>([]);
  const { cycleMode } = useTheme();
  const closeCanvas = useCloseCanvas();

  const recentsStore = useMemo(
    () => (selectedTenantId === null ? null : recentsStoreForBench(selectedTenantId)),
    [selectedTenantId],
  );

  // Recents are per bench: loaded during render when the store changes, so
  // the palette never opens on the previous bench's entries.
  const [recentsFor, setRecentsFor] = useState(recentsStore);
  if (recentsFor !== recentsStore) {
    setRecentsFor(recentsStore);
    setRecents(recentsStore?.load() ?? []);
  }

  const pushRecent = useCallback(
    (entry: RecentEntry) => {
      if (recentsStore === null) return;
      setRecents(recentsStore.push(entry));
    },
    [recentsStore],
  );

  const removeRecent = useCallback(
    (entry: Pick<RecentEntry, "kind" | "id">) => {
      if (recentsStore === null) return;
      setRecents(recentsStore.remove(entry));
    },
    [recentsStore],
  );

  // A workbench-level 404 means a Recents entry outlived the workbench it
  // points at — drop it so re-opening never offers a dead end again.
  useEffect(() => {
    function onWorkbenchNotFound(event: Event) {
      const workbenchId = (event as CustomEvent<string>).detail;
      removeRecent({
        kind: "workbenches",
        id: `entity:workbenches:${workbenchId}`,
      });
    }
    window.addEventListener(WORKBENCH_NOT_FOUND_EVENT, onWorkbenchNotFound);
    return () => {
      window.removeEventListener(WORKBENCH_NOT_FOUND_EVENT, onWorkbenchNotFound);
    };
  }, [removeRecent]);

  // Reads through the shared query key, not `listWorkbenches` directly,
  // so every re-search reuses one cached fetch instead of its own request.
  const listWorkbenchesForSearch = useCallback(async () => {
    if (selectedTenantId === null) return [];
    const result = await queryClient.ensureQueryData({
      queryKey: tenantKeys.workbenches(selectedTenantId, "workbench"),
      queryFn: () => listWorkbenches(selectedTenantId, "workbench"),
    });
    return result.map((workbench) => ({
      id: workbench.id,
      name: workbench.title,
    }));
  }, [selectedTenantId, queryClient]);

  // A palette hit opens a chat with the agent, so the search source is the
  // same chat-partner listing the roster and the Agents page read — its
  // `id` is exactly what `chatPath` expects.
  const listAgentsForSearch = useCallback(async () => {
    if (selectedTenantId === null) return [];
    const agents = await listChatAgents(selectedTenantId);
    return agents.map((agent) => ({ id: agent.id, name: agent.name }));
  }, [selectedTenantId]);

  const entitySearchSources = useMemo(
    () => [
      { category: "workbenches", fetch: listWorkbenchesForSearch },
      { category: "agents", fetch: listAgentsForSearch },
    ],
    [listWorkbenchesForSearch, listAgentsForSearch],
  );

  const strippedQuery = useMemo(() => parsePaletteQuery(query).query, [query]);
  const bareScopeKind = useMemo(() => {
    if (!isBareScopeQuery(query)) return null;
    return parsePaletteQuery(query).scope?.kind ?? null;
  }, [query]);

  const { results, loading, error, hasMore, loadMore } = useEntitySearch({
    query: strippedQuery,
    enabled: open,
    sources: entitySearchSources,
  });

  // A bare `#`/`@` strips to an empty query, which useEntitySearch never
  // fetches for by design — so fetch that scope's raw list directly.
  const bareWorkbenchesQuery = useQuery({
    queryKey: [...tenantKeys.workbenches(selectedTenantId ?? "", "workbench"), "bare-scope"],
    enabled: bareScopeKind === "workbenches" && open && selectedTenantId !== null,
    queryFn: listWorkbenchesForSearch,
  });
  const bareWorkbenches: readonly PaletteResultItem[] = (bareWorkbenchesQuery.data ?? []).map(
    (row) => ({ id: `entity:workbenches:${row.id}`, title: row.name }),
  );

  const bareAgentsQuery = useQuery({
    queryKey: ["tenant", selectedTenantId ?? "", "agents", "bare-scope"],
    enabled: bareScopeKind === "people" && open && selectedTenantId !== null,
    queryFn: listAgentsForSearch,
  });
  const bareAgents: readonly PaletteResultItem[] = (bareAgentsQuery.data ?? []).map((row) => ({
    id: `entity:agents:${row.id}`,
    title: row.name,
    subtitle: "Agent",
  }));

  const routinesQuery = useTenantQuery(
    tenantKeys.routines(selectedTenantId ?? ""),
    open && selectedTenantId !== null,
    () => listScheduledWorkflows(selectedTenantId ?? ""),
  );
  const skillsQuery = useTenantQuery(
    tenantKeys.skills(selectedTenantId ?? ""),
    open && selectedTenantId !== null,
    () => listSkills(selectedTenantId ?? ""),
  );
  const artifactsQuery = useAPIQuery(
    selectedTenantId === null || !open ? "" : `/api/tenants/${selectedTenantId}/artifacts`,
    ArtifactListPageSchema,
  );

  // The sidebar dropped its bench switcher, so this is the hidden escape
  // hatch: cycles to the next workbench in membership order, absent
  // entirely for the common one-workbench account.
  const workbenchMemberships = benchMemberships;
  const nextWorkbench =
    workbenchMemberships.length > 1
      ? workbenchMemberships[
          (workbenchMemberships.findIndex(
            (membership) => membership.tenantId === selectedTenantId,
          ) +
            1) %
            workbenchMemberships.length
        ]
      : undefined;

  // cmd+K opens; it cannot also close, because react-ui's shortcut yields to
  // text fields and an open palette holds focus in its own input. Escape and
  // the overlay are the ways back out.
  useCommandShortcut(openCommandPalette);

  // A route change or bench switch closes the palette, so it never stands
  // over content it wasn't opened from. A tenant resolving for the first
  // time (boot) is not a switch.
  const [searchScope, setSearchScope] = useState({ path, tenantId: selectedTenantId });
  if (searchScope.path !== path || searchScope.tenantId !== selectedTenantId) {
    const benchSwitched =
      searchScope.tenantId !== null && searchScope.tenantId !== selectedTenantId;
    const routeChanged = searchScope.path !== path;
    setSearchScope({ path, tenantId: selectedTenantId });
    if (routeChanged || benchSwitched) setCommandPaletteOpen(false);
  }

  const pageItems = useMemo<readonly PaletteResultItem[]>(
    () =>
      STATIC_COMMANDS.map((command) => ({
        id: command.id,
        title: command.title,
      })),
    [],
  );

  const actionItems = useMemo<readonly PaletteResultItem[]>(() => {
    const commands = ACTION_COMMANDS.map((command) => ({
      id: `action:${command.id}`,
      title: command.title,
      subtitle: command.subtitle,
    }));
    const runNow =
      routinesQuery.kind === "ready"
        ? routinesQuery.data.map((routine) => ({
            id: `action:run-routine:${routine.definitionId}`,
            title: `Run · ${routine.name}`,
            subtitle: "Run this routine now",
          }))
        : [];
    const switchWorkbench =
      nextWorkbench !== undefined
        ? [
            {
              id: "action:switch-workbench",
              title: "Switch workbench",
              subtitle: `Next: ${nextWorkbench.tenantName}`,
            },
          ]
        : [];
    return [...commands, ...runNow, ...switchWorkbench];
  }, [routinesQuery, nextWorkbench]);

  const workbenchItems = useMemo<readonly PaletteResultItem[]>(() => {
    if (bareScopeKind === "workbenches") return bareWorkbenches;
    return results
      .filter((result) => result.category === "workbenches")
      .map((workbench) => ({
        id: `entity:workbenches:${workbench.id}`,
        title: workbench.title,
      }));
  }, [results, bareScopeKind, bareWorkbenches]);

  const agentItems = useMemo<readonly PaletteResultItem[]>(() => {
    if (bareScopeKind === "people") return bareAgents;
    return results
      .filter((result) => result.category === "agents")
      .map((agent) => ({
        id: `entity:agents:${agent.id}`,
        title: agent.title,
        subtitle: "Agent",
      }));
  }, [results, bareScopeKind, bareAgents]);

  const routineItems = useMemo<readonly PaletteResultItem[]>(
    () =>
      routinesQuery.kind === "ready"
        ? routinesQuery.data.map((routine) => ({
            id: `entity:routines:${routine.definitionId}`,
            title: routine.name,
            subtitle: "Scheduled workflow",
          }))
        : [],
    [routinesQuery],
  );

  const skillItems = useMemo<readonly PaletteResultItem[]>(
    () =>
      skillsQuery.kind === "ready"
        ? skillsQuery.data.map((skill) => ({
            id: `entity:skills:${skill.name}`,
            title: skill.name,
            subtitle: skill.description,
          }))
        : [],
    [skillsQuery],
  );

  const libraryItems = useMemo<readonly PaletteResultItem[]>(
    () =>
      artifactsQuery.kind === "ready"
        ? artifactsQuery.data.artifacts.map((artifact) => ({
            id: `entity:library:${artifact.id}`,
            title: artifact.title,
            subtitle: artifactKindLabel(artifact.kind),
          }))
        : [],
    [artifactsQuery],
  );

  // Order matches the mock's buildCmdkEntries.
  const sources = useMemo<readonly PaletteSource[]>(
    () => [
      {
        id: "actions",
        heading: "Commands",
        kind: "actions",
        items: actionItems,
      },
      {
        id: "workbenches",
        heading: "Agents & Channels",
        kind: "workbenches",
        items: workbenchItems,
      },
      { id: "pages", heading: "Pages", kind: "pages", items: pageItems },
      { id: "routines", heading: "Workflows", items: routineItems },
      { id: "skills", heading: "Skills", items: skillItems },
      { id: "library", heading: "Artifacts", items: libraryItems },
      {
        id: "people",
        heading: "People & agents",
        kind: "people",
        items: agentItems,
      },
    ],
    [actionItems, workbenchItems, pageItems, routineItems, skillItems, libraryItems, agentItems],
  );

  const recentItems = useMemo<readonly PaletteResultItem[]>(
    () =>
      recents.map((entry) =>
        entry.subtitle === undefined
          ? { id: entry.id, title: entry.title }
          : { id: entry.id, title: entry.title, subtitle: entry.subtitle },
      ),
    [recents],
  );

  const groups = useMemo<readonly CommandPaletteGroup[]>(() => {
    const built = buildCommandPaletteGroups({
      query,
      recents: recentItems,
      sources,
    });
    return built.map((group) => ({
      id: group.id,
      heading: group.heading,
      items: group.items,
    }));
  }, [query, recentItems, sources]);

  const handleSelect = useCallback(
    (id: string) => {
      if (id === "action:switch-workbench") {
        if (nextWorkbench !== undefined) selectTenant(nextWorkbench.tenantId);
      } else if (id.startsWith("action:run-routine:")) {
        const routineId = id.slice("action:run-routine:".length);
        if (selectedTenantId !== null) {
          void (async () => {
            try {
              await runScheduledWorkflowNow(selectedTenantId, routineId);
            } catch (cause) {
              reportError(cause, {
                operation: "scheduled_workflow_run_now",
                tenantId: selectedTenantId,
              });
            }
          })();
        }
        navigate(`/workflows/${encodeURIComponent(routineId)}`);
      } else if (id.startsWith("action:")) {
        void runActionCommand(id.slice("action:".length) as ActionCommandId, {
          path,
          navigate,
          tenantId: selectedTenantId,
          cycleTheme: cycleMode,
          closeCanvas,
        });
      } else if (id.startsWith("route:")) {
        const routePath = id.slice("route:".length);
        const label = STATIC_COMMANDS.find((command) => command.id === id)?.title ?? routePath;
        navigate(routePath);
        pushRecent({ kind: "route", id, title: label });
      } else if (id.startsWith("entity:workbenches:")) {
        const workbenchId = id.slice("entity:workbenches:".length);
        const title = workbenchItems.find((item) => item.id === id)?.title ?? workbenchId;
        navigate(`/w/${workbenchId}`);
        pushRecent({ kind: "workbenches", id, title, subtitle: "Workbench" });
      } else if (id.startsWith("entity:agents:")) {
        const agentId = id.slice("entity:agents:".length);
        const title = agentItems.find((item) => item.id === id)?.title ?? agentId;
        navigate(chatPath(agentId));
        pushRecent({ kind: "agents", id, title, subtitle: "Agent" });
      } else if (id.startsWith("entity:routines:")) {
        const routineId = id.slice("entity:routines:".length);
        const title = routineItems.find((item) => item.id === id)?.title ?? routineId;
        navigate(`/workflows/${encodeURIComponent(routineId)}`);
        pushRecent({ kind: "routines", id, title, subtitle: "Workflow" });
      } else if (id.startsWith("entity:skills:")) {
        const skillId = id.slice("entity:skills:".length);
        const title = skillItems.find((item) => item.id === id)?.title ?? skillId;
        // A skill's name is its slug: the Skills API keys every route on it.
        navigate(detailPath(SKILLS_PATH_PREFIX, { slug: skillId, id: skillId }));
        pushRecent({ kind: "skills", id, title, subtitle: "Skill" });
      } else if (id.startsWith("entity:library:")) {
        const artifactId = id.slice("entity:library:".length);
        const title = libraryItems.find((item) => item.id === id)?.title ?? "Artifacts";
        navigate(libraryArtifactPath(artifactId));
        pushRecent({ kind: "library", id, title, subtitle: "Artifacts" });
      }
      setCommandPaletteOpen(false);
    },
    [
      navigate,
      path,
      selectedTenantId,
      cycleMode,
      closeCanvas,
      pushRecent,
      workbenchItems,
      agentItems,
      routineItems,
      skillItems,
      libraryItems,
      nextWorkbench,
      selectTenant,
    ],
  );

  return (
    <>
      {children}
      <CommandPalette
        open={open}
        onOpenChange={setCommandPaletteOpen}
        query={query}
        onQueryChange={setCommandPaletteQuery}
        groups={groups}
        onSelect={handleSelect}
        loading={loading}
        {...(error ? { error: "Search failed. Try again." } : {})}
        hasMore={hasMore}
        onLoadMore={loadMore}
        placeholder="Search or jump to…"
        footer="# workbenches · @ people · > actions · / pages"
      />
    </>
  );
}
