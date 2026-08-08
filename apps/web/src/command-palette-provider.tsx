import { CommandPalette, useCommandShortcut } from "@corbits/react-ui";
import type { CommandAction } from "@corbits/react-ui";
import { listChannels } from "@corbits/chat-ui";
import { buildStaticCommands } from "@corbits/command-palette";
import { useEffect, useMemo, useState } from "react";

import { NAV_ROUTES } from "./routes";
import { RunsSchema, useAPIQuery } from "./api";
import { useBench } from "./bench-context";
import type { Navigate } from "./navigation";

const STATIC_COMMANDS = buildStaticCommands(
  NAV_ROUTES.map((route) => ({ path: route.path, label: route.label })),
);

/**
 * Wires the react-ui command palette into the app shell: the static
 * commands come from the routes the shell already renders, and entity
 * results come from the same `listChannels`/`listRuns` calls the Chat and
 * Workflows pages already use — this file adds no new fetch of its own.
 *
 * The installed react-ui version's `Command` filters its own `actions` list
 * against its internal query state (there is no `onQueryChange` yet to hand
 * a query out to), so every fetched channel and run is handed over as an
 * action up front and left to that built-in match-as-you-type; nothing here
 * re-implements matching. Once the newer, data-driven `CommandPalette` (the
 * `command-palette` react-ui branch) is published and pinned, this file
 * switches to passing `@corbits/command-palette`'s `searchEntities` result
 * through `onQueryChange` instead — see docs/command-palette.md.
 */
export function CommandPaletteProvider({
  navigate,
}: {
  readonly navigate: Navigate;
}) {
  const { selectedTenantId } = useBench();
  const [open, setOpen] = useState(false);
  const [channels, setChannels] = useState<
    readonly { id: string; name: string }[]
  >([]);
  const runsQuery = useAPIQuery("/api/me/workflows/runs", RunsSchema);

  useEffect(() => {
    if (!open || selectedTenantId === null) return;
    let cancelled = false;
    void listChannels(selectedTenantId, "channel").then((result) => {
      if (!cancelled)
        setChannels(
          result.map((channel) => ({ id: channel.id, name: channel.title })),
        );
    });
    return () => {
      cancelled = true;
    };
  }, [open, selectedTenantId]);

  useCommandShortcut(() => setOpen((current) => !current));

  const actions = useMemo<CommandAction[]>(() => {
    const staticActions = STATIC_COMMANDS.map((command) => ({
      id: command.id,
      label: command.title,
      group: "Pages",
      run: () => navigate(command.path),
    }));
    const channelActions = channels.map((channel) => ({
      id: `entity:channels:${channel.id}`,
      label: channel.name,
      group: "Channels",
      run: () => navigate(`/chat/${channel.id}`),
    }));
    const runActions =
      runsQuery.kind === "ready"
        ? runsQuery.data.data.map((run) => ({
            id: `entity:routines:${run.id}`,
            label: run.definitionName,
            group: "Routines",
            run: () => navigate("/workflows"),
          }))
        : [];
    return [...staticActions, ...channelActions, ...runActions];
  }, [channels, runsQuery, navigate]);

  return (
    <CommandPalette
      open={open}
      onOpenChange={setOpen}
      actions={actions}
      placeholder="Search or jump to…"
    />
  );
}
