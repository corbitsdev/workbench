import {
  CommandPalette,
  useCommandShortcut,
  useTheme,
} from "@corbits/react-ui";
import type { CommandPaletteGroup } from "@corbits/react-ui";
import { listChannels } from "@corbits/chat-ui";
import {
  buildCommandPaletteGroups,
  buildStaticCommands,
  isBareScopeQuery,
  parsePaletteQuery,
  useEntitySearch,
  type PaletteResultItem,
  type PaletteSource,
  type RecentEntry,
} from "@corbits/command-palette";
import { useStageChrome } from "@corbits/shell-layout";
import { useCallback, useEffect, useMemo, useState } from "react";

import { listAgentDefinitions } from "./agents-api";
import {
  ACTION_COMMANDS,
  runActionCommand,
  type ActionCommandId,
} from "./command-palette-actions";
import { OPEN_COMMAND_PALETTE_EVENT } from "./command-palette-events";
import { recentsStoreForBench } from "./command-palette-recents";
import { NAV_ROUTES } from "./routes";
import { ArtifactListPageSchema, RunsSchema, useAPIQuery } from "./api";
import { useBench } from "./bench-context";
import { useCloseCanvas } from "./shell/canvas-availability";
import { listRoutines, runRoutineNow, useTenantQuery } from "./routines-api";
import { useSessionSkills } from "./skills-session";
import { tenantKeys } from "./query-client";
import type { Navigate } from "./navigation";

const STATIC_COMMANDS = buildStaticCommands(
  NAV_ROUTES.map((route) => ({ path: route.path, label: route.label })),
);

/**
 * Wires the data-driven react-ui command palette into the app shell.
 *
 * Grouping, `#`/`@`/`>`/`/` scope parsing, and the Recents rule live in
 * `@corbits/command-palette` (`buildCommandPaletteGroups`) — this file only
 * assembles the app's own sources (routes, channels, agents, routines,
 * skills, library artifacts) and maps a selection back to a real route or
 * action. Entity results for channels/runs/agents still come off the same
 * `useEntitySearch` paging this provider already used; routines, skills and
 * library artifacts are small per-bench catalogs fetched once and filtered
 * client-side, the same way the static route list already is.
 *
 * react-ui's `CommandPalette` has no slot for a scope-chip badge or the
 * footer prefix legend the mock shows next to the input — see the PR
 * description for that flag; this provider ships everything its `groups` /
 * `items` API can express.
 */
export function CommandPaletteProvider({
  path,
  navigate,
}: {
  readonly path: string;
  readonly navigate: Navigate;
}) {
  const { selectedTenantId } = useBench();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<readonly RecentEntry[]>([]);
  const runsQuery = useAPIQuery("/api/me/workflows/runs", RunsSchema);
  const { cycleMode } = useTheme();
  const closeCanvas = useCloseCanvas();
  const { toggleCol2 } = useStageChrome();

  const recentsStore = useMemo(
    () =>
      selectedTenantId === null ? null : recentsStoreForBench(selectedTenantId),
    [selectedTenantId],
  );

  useEffect(() => {
    setRecents(recentsStore?.load() ?? []);
  }, [recentsStore]);

  const pushRecent = useCallback(
    (entry: RecentEntry) => {
      if (recentsStore === null) return;
      setRecents(recentsStore.push(entry));
    },
    [recentsStore],
  );

  const listChannelsForSearch = useCallback(async () => {
    if (selectedTenantId === null) return [];
    const result = await listChannels(selectedTenantId, "channel");
    return result.map((channel) => ({ id: channel.id, name: channel.title }));
  }, [selectedTenantId]);

  // Workflow runs are what the Routines page lists today. The group is labeled
  // "Runs" (truthful source) and navigates to `/routines/:id` — never the dead
  // `/workflows` path the previous palette hard-coded.
  const listRunsForSearch = useCallback(async () => {
    if (runsQuery.kind !== "ready") return [];
    return runsQuery.data.data.map((run) => ({
      id: run.id,
      name: run.definitionName,
    }));
  }, [runsQuery]);

  const listAgentsForSearch = useCallback(async () => {
    if (selectedTenantId === null) return [];
    const definitions = await listAgentDefinitions(selectedTenantId);
    return definitions.map((definition) => ({
      id: definition.id,
      name: definition.name,
    }));
  }, [selectedTenantId]);

  const entitySearchSources = useMemo(
    () => [
      { category: "channels", fetch: listChannelsForSearch },
      { category: "runs", fetch: listRunsForSearch },
      { category: "agents", fetch: listAgentsForSearch },
    ],
    [listChannelsForSearch, listRunsForSearch, listAgentsForSearch],
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

  // A bare `#` or `@` strips to an empty query, which useEntitySearch never
  // fetches for (by design — the unscoped default view should not dump
  // every entity on open). The mock shows every item in an active scope for
  // this input, so fetch that scope's raw list directly instead.
  const [bareChannels, setBareChannels] = useState<
    readonly PaletteResultItem[]
  >([]);
  const [bareAgents, setBareAgents] = useState<readonly PaletteResultItem[]>(
    [],
  );

  useEffect(() => {
    if (bareScopeKind !== "channels" || !open) {
      setBareChannels([]);
      return;
    }
    let cancelled = false;
    void listChannelsForSearch().then((rows) => {
      if (cancelled) return;
      setBareChannels(
        rows.map((row) => ({
          id: `entity:channels:${row.id}`,
          title: row.name,
        })),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [bareScopeKind, open, listChannelsForSearch]);

  useEffect(() => {
    if (bareScopeKind !== "people" || !open) {
      setBareAgents([]);
      return;
    }
    let cancelled = false;
    void listAgentsForSearch().then((rows) => {
      if (cancelled) return;
      setBareAgents(
        rows.map((row) => ({
          id: `entity:agents:${row.id}`,
          title: row.name,
          subtitle: "Agent",
        })),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [bareScopeKind, open, listAgentsForSearch]);

  const routinesQuery = useTenantQuery(
    tenantKeys.routines(selectedTenantId ?? ""),
    open && selectedTenantId !== null,
    () => listRoutines(selectedTenantId ?? ""),
  );
  const skills = useSessionSkills();
  const artifactsQuery = useAPIQuery(
    selectedTenantId === null || !open
      ? ""
      : `/api/tenants/${selectedTenantId}/artifacts`,
    ArtifactListPageSchema,
  );

  useCommandShortcut(() => setOpen((current) => !current));

  useEffect(() => {
    function onOpenRequest() {
      setOpen(true);
    }
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenRequest);
    return () => {
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenRequest);
    };
  }, []);

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
            id: `action:run-routine:${routine.id}`,
            title: `Run · ${routine.name}`,
            subtitle: "Run this routine now",
          }))
        : [];
    return [...commands, ...runNow];
  }, [routinesQuery]);

  const channelItems = useMemo<readonly PaletteResultItem[]>(() => {
    if (bareScopeKind === "channels") return bareChannels;
    return results
      .filter((result) => result.category === "channels")
      .map((channel) => ({
        id: `entity:channels:${channel.id}`,
        title: channel.title,
      }));
  }, [results, bareScopeKind, bareChannels]);

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

  const runItems = useMemo<readonly PaletteResultItem[]>(
    () =>
      results
        .filter((result) => result.category === "runs")
        .map((run) => ({
          id: `entity:runs:${run.id}`,
          title: run.title,
        })),
    [results],
  );

  const routineItems = useMemo<readonly PaletteResultItem[]>(
    () =>
      routinesQuery.kind === "ready"
        ? routinesQuery.data.map((routine) => ({
            id: `entity:routines:${routine.id}`,
            title: routine.name,
            subtitle:
              routine.scope === "personal"
                ? "Personal routine"
                : "Bench routine",
          }))
        : [],
    [routinesQuery],
  );

  const skillItems = useMemo<readonly PaletteResultItem[]>(
    () =>
      skills.map((skill) => ({
        id: `entity:skills:${skill.id}`,
        title: skill.name,
        subtitle: skill.description,
      })),
    [skills],
  );

  const libraryItems = useMemo<readonly PaletteResultItem[]>(
    () =>
      artifactsQuery.kind === "ready"
        ? artifactsQuery.data.data.map((artifact) => ({
            id: `entity:library:${artifact.id}`,
            title: artifact.title,
            subtitle: artifact.kind,
          }))
        : [],
    [artifactsQuery],
  );

  // Order matches the mock's buildCmdkEntries: Commands, Channels, Pages,
  // then the unscoped catalogs (Runs, Routines, Skills, Library), with
  // People & agents last among the palette's groups.
  const sources = useMemo<readonly PaletteSource[]>(
    () => [
      {
        id: "actions",
        heading: "Commands",
        kind: "actions",
        items: actionItems,
      },
      {
        id: "channels",
        heading: "Channels",
        kind: "channels",
        items: channelItems,
      },
      { id: "pages", heading: "Pages", kind: "pages", items: pageItems },
      { id: "runs", heading: "Runs", items: runItems },
      { id: "routines", heading: "Routines", items: routineItems },
      { id: "skills", heading: "Skills", items: skillItems },
      { id: "library", heading: "Library", items: libraryItems },
      {
        id: "people",
        heading: "People & agents",
        kind: "people",
        items: agentItems,
      },
    ],
    [
      actionItems,
      channelItems,
      pageItems,
      runItems,
      routineItems,
      skillItems,
      libraryItems,
      agentItems,
    ],
  );

  const recentItems = useMemo<readonly PaletteResultItem[]>(
    () =>
      recents.map((entry) => ({
        id: entry.id,
        title: entry.title,
        ...(entry.subtitle === undefined ? {} : { subtitle: entry.subtitle }),
      })),
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
      if (id.startsWith("action:run-routine:")) {
        const routineId = id.slice("action:run-routine:".length);
        if (selectedTenantId !== null) {
          void runRoutineNow(selectedTenantId, routineId);
        }
        navigate(`/routines/${encodeURIComponent(routineId)}`);
      } else if (id.startsWith("action:")) {
        void runActionCommand(id.slice("action:".length) as ActionCommandId, {
          path,
          navigate,
          tenantId: selectedTenantId,
          cycleTheme: cycleMode,
          closeCanvas,
          toggleCol2,
        });
      } else if (id.startsWith("route:")) {
        const routePath = id.slice("route:".length);
        const label =
          STATIC_COMMANDS.find((command) => command.id === id)?.title ??
          routePath;
        navigate(routePath);
        pushRecent({ kind: "route", id, title: label });
      } else if (id.startsWith("entity:channels:")) {
        const channelId = id.slice("entity:channels:".length);
        const title =
          channelItems.find((item) => item.id === id)?.title ?? channelId;
        navigate(`/c/${channelId}`);
        pushRecent({ kind: "channels", id, title, subtitle: "Channel" });
      } else if (id.startsWith("entity:runs:")) {
        // Routines page owns the /routines prefix (including detail segments).
        const runId = id.slice("entity:runs:".length);
        const title = runItems.find((item) => item.id === id)?.title ?? runId;
        navigate(`/routines/${runId}`);
        pushRecent({ kind: "runs", id, title, subtitle: "Run" });
      } else if (id.startsWith("entity:agents:")) {
        const agentId = id.slice("entity:agents:".length);
        const title =
          agentItems.find((item) => item.id === id)?.title ?? agentId;
        navigate(`/settings/agents/${encodeURIComponent(agentId)}`);
        pushRecent({ kind: "agents", id, title, subtitle: "Agent" });
      } else if (id.startsWith("entity:routines:")) {
        const routineId = id.slice("entity:routines:".length);
        const title =
          routineItems.find((item) => item.id === id)?.title ?? routineId;
        navigate(`/routines/${encodeURIComponent(routineId)}`);
        pushRecent({ kind: "routines", id, title, subtitle: "Routine" });
      } else if (id.startsWith("entity:skills:")) {
        const skillId = id.slice("entity:skills:".length);
        const title =
          skillItems.find((item) => item.id === id)?.title ?? skillId;
        navigate(`/settings/skills/${encodeURIComponent(skillId)}`);
        pushRecent({ kind: "skills", id, title, subtitle: "Skill" });
      } else if (id.startsWith("entity:library:")) {
        // Library detail is local page state, not a route — see the PR
        // description flag. This opens the Library list.
        const title =
          libraryItems.find((item) => item.id === id)?.title ?? "Library";
        navigate("/library");
        pushRecent({ kind: "library", id, title, subtitle: "Library" });
      }
      setOpen(false);
    },
    [
      navigate,
      path,
      selectedTenantId,
      cycleMode,
      closeCanvas,
      toggleCol2,
      pushRecent,
      channelItems,
      runItems,
      agentItems,
      routineItems,
      skillItems,
      libraryItems,
    ],
  );

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) setQuery("");
  }, []);

  return (
    <CommandPalette
      open={open}
      onOpenChange={handleOpenChange}
      query={query}
      onQueryChange={setQuery}
      groups={groups}
      onSelect={handleSelect}
      loading={loading}
      error={error ? "Search failed. Try again." : undefined}
      hasMore={hasMore}
      onLoadMore={loadMore}
      placeholder="Search or jump to… (# channels · @ people · > actions · / pages)"
    />
  );
}
