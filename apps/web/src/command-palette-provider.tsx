import { CommandPalette, useCommandShortcut } from "@corbits/react-ui";
import type { CommandPaletteGroup } from "@corbits/react-ui";
import { listChannels } from "@corbits/chat-ui";
import {
  buildStaticCommands,
  matchesQuery,
  useEntitySearch,
} from "@corbits/command-palette";
import { useCallback, useMemo, useState } from "react";

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
 * results come from the same `listChannels`/workflow-runs calls the Chat and
 * Workflows pages already use — this file adds no new fetch of its own. The
 * typed query is debounced and paginated by `useEntitySearch`; this provider
 * only groups the results it returns and maps a selection back to a
 * navigation. Ranking, matching, and the "no raw identifier on screen"
 * floor all live in `@corbits/command-palette` and `@corbits/react-ui` —
 * see docs/command-palette.md.
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

  const listRunsForSearch = useCallback(async () => {
    if (runsQuery.kind !== "ready") return [];
    return runsQuery.data.data.map((run) => ({
      id: run.id,
      name: run.definitionName,
    }));
  }, [runsQuery]);

  const { results, loading, error, hasMore, loadMore } = useEntitySearch({
    query,
    enabled: open,
    listChannels: listChannelsForSearch,
    listRuns: listRunsForSearch,
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
    const routines = results.filter((result) => result.category === "routines");

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
    if (routines.length > 0) {
      groups.push({
        id: "routines",
        heading: "Routines",
        items: routines.map((run) => ({
          id: `entity:routines:${run.id}`,
          title: run.title,
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
        navigate(`/chat/${id.slice("entity:channels:".length)}`);
      } else if (id.startsWith("entity:routines:")) {
        navigate("/workflows");
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
