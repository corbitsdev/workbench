import { CommandPalette, useCommandShortcut } from "@corbits/react-ui";
import type { CommandPaletteGroup } from "@corbits/react-ui";
import { listChannels } from "@corbits/chat-ui";
import {
  buildStaticCommands,
  matchesQuery,
  useEntitySearch,
} from "@corbits/command-palette";
import { useCallback, useMemo, useState } from "react";

import { listAgentDefinitions } from "./agents-api";
import { NAV_ROUTES } from "./routes";
import { RunsSchema, useAPIQuery } from "./api";
import { useBench } from "./bench-context";
import type { Navigate } from "./navigation";

const STATIC_COMMANDS = buildStaticCommands(
  NAV_ROUTES.map((route) => ({ path: route.path, label: route.label })),
);

/**
 * Wires the data-driven react-ui command palette into the app shell.
 *
 * Static commands come from the routes the shell already renders; entity
 * results come from the same listChannels / workflow-runs / agent-definitions
 * calls the product pages already use — this file adds no new fetch of its
 * own beyond those. Sources are free-form labels the package carries through
 * so this provider can group results and map a selection to a real route.
 * Ranking, matching, and the "no raw identifier on screen" floor all live in
 * `@corbits/command-palette` and `@corbits/react-ui`.
 */
export function CommandPaletteProvider({
  navigate,
}: {
  readonly navigate: Navigate;
}) {
  const { selectedTenantId } = useBench();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const runsQuery = useAPIQuery("/api/me/workflows/runs", RunsSchema);

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

  const sources = useMemo(
    () => [
      { category: "channels", fetch: listChannelsForSearch },
      { category: "runs", fetch: listRunsForSearch },
      { category: "agents", fetch: listAgentsForSearch },
    ],
    [listChannelsForSearch, listRunsForSearch, listAgentsForSearch],
  );

  const { results, loading, error, hasMore, loadMore } = useEntitySearch({
    query,
    enabled: open,
    sources,
  });

  useCommandShortcut(() => setOpen((current) => !current));

  const groups = useMemo<readonly CommandPaletteGroup[]>(() => {
    // Pages are matched here, client-side: they are a tiny fixed list, so
    // there is no debounce or fetch to wait on — show the matches the moment
    // the query changes (and all of them when it is empty).
    const pages = STATIC_COMMANDS.filter((command) =>
      matchesQuery(command.title, query),
    );
    const channels = results.filter((result) => result.category === "channels");
    const runs = results.filter((result) => result.category === "runs");
    const agents = results.filter((result) => result.category === "agents");

    const groups: CommandPaletteGroup[] = [];
    if (pages.length > 0) {
      groups.push({
        id: "pages",
        heading: "Pages",
        items: pages.map((command) => ({
          id: command.id,
          title: command.title,
        })),
      });
    }
    if (channels.length > 0) {
      groups.push({
        id: "channels",
        heading: "Channels",
        items: channels.map((channel) => ({
          id: `entity:channels:${channel.id}`,
          title: channel.title,
        })),
      });
    }
    if (runs.length > 0) {
      groups.push({
        id: "runs",
        heading: "Runs",
        items: runs.map((run) => ({
          id: `entity:runs:${run.id}`,
          title: run.title,
        })),
      });
    }
    if (agents.length > 0) {
      groups.push({
        id: "agents",
        heading: "Agents",
        items: agents.map((agent) => ({
          id: `entity:agents:${agent.id}`,
          title: agent.title,
        })),
      });
    }
    return groups;
  }, [results, query]);

  const handleSelect = useCallback(
    (id: string) => {
      if (id.startsWith("route:")) {
        navigate(id.slice("route:".length));
      } else if (id.startsWith("entity:channels:")) {
        navigate(`/c/${id.slice("entity:channels:".length)}`);
      } else if (id.startsWith("entity:runs:")) {
        // Routines page owns the /routines prefix (including detail segments).
        navigate(`/routines/${id.slice("entity:runs:".length)}`);
      } else if (id.startsWith("entity:agents:")) {
        navigate("/agents");
      }
      setOpen(false);
    },
    [navigate],
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
      placeholder="Search or jump to…"
    />
  );
}
