// The sidebar's one list: every workbench (an agent conversation, each its
// own tenancy under the hood) as a flat run of rows — no kind sections, no
// per-page variants. Pinned rows float to the top; everything else keeps
// the order the platform returns. The "Working" group above the rows is the
// signed-in user's running tasks (spawn-and-return; results land in the
// Inbox), not a workbench kind.

import {
  Badge,
  EmptyState,
  formatRelativeTime,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Skeleton,
} from "@corbits/react-ui";
import { toast } from "@corbits/react-ui";
import {
  CHAT_STRINGS,
  channelsQueryKeyPrefix,
  patchChannelSettings,
} from "@corbits/chat-ui";
import type { Channel } from "@corbits/chat-ui";
import { WorkingTaskRow } from "@corbits/tasks-ui";
import { useQueryClient } from "@tanstack/react-query";
import { Hash, MessageSquare, MoreHorizontal, Search } from "lucide-react";
import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";

import { useBench } from "../bench-context";
import { channelIdFromPath, channelPath } from "../channel-path";
import {
  REQUEST_CHANNEL_RENAME_EVENT,
  isChannelRenameRequestFor,
} from "../channel-rename-events";
import { useBenchActivity } from "./bench-activity";

/**
 * The ellipsis-menu item labels for a workbench row: rename and the
 * pin/unpin toggle — a strict subset of the conversation's own settings.
 * Pure so the pinned-state wording ("Pin" vs "Unpin") is testable without
 * opening the (portaled, Radix) menu.
 */
export function rowMenuLabels(
  channel: Pick<Channel, "pinned">,
): readonly [rename: string, pinToggle: string] {
  return [
    CHAT_STRINGS.rowMenuRename,
    channel.pinned ? CHAT_STRINGS.rowMenuUnpin : CHAT_STRINGS.rowMenuPin,
  ];
}

/**
 * What a rename submission should send: `undefined` for input that resolves
 * to nothing worth saving (blank, or unchanged from the row's current
 * title) — the caller's cue to treat the rename as a no-op cancel rather
 * than firing an empty-name PATCH.
 */
export function renamePayload(
  input: string,
  currentTitle: string,
): string | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed === currentTitle) return undefined;
  return trimmed;
}

/**
 * Optional row signals (shared / live / time / unread). The platform's
 * listing carries `unreadCount`/`lastActivityAt`/`live` when a mailbox
 * could be resolved, and `sharedLabel` for a conversation projected in via
 * bilateral trust. Render only when present; never invent counts or
 * timestamps.
 */
export type WorkbenchRowSignals = {
  readonly sharedLabel?: string;
  readonly live?: boolean;
  readonly time?: string;
  readonly unread?: number;
};

/**
 * The signals one row shows, pure so the "open workbench never shows a
 * stale unread badge" rule is testable without rendering. `isOpen` reflects
 * the badge clearing the instant a conversation opens: the read-state PUT
 * fires as soon as the root feed loads, but this list's fetch doesn't
 * refetch on navigation, so the open row's count is forced to 0 locally.
 */
export function workbenchRowSignals(
  channel: Pick<
    Channel,
    "unreadCount" | "lastActivityAt" | "live" | "sharedLabel"
  >,
  isOpen: boolean,
): WorkbenchRowSignals {
  return {
    ...(channel.sharedLabel !== undefined
      ? { sharedLabel: channel.sharedLabel }
      : {}),
    ...(channel.live !== undefined ? { live: channel.live } : {}),
    ...(channel.lastActivityAt !== undefined
      ? { time: formatRelativeTime(channel.lastActivityAt) }
      : {}),
    ...(channel.unreadCount !== undefined
      ? { unread: isOpen ? 0 : channel.unreadCount }
      : {}),
  };
}

/**
 * Flat ordering for the one list: pinned rows first, everything else in the
 * order given. Stable within each half so the platform's own ordering is
 * never scrambled. Pure so the "no kind sections" rule is testable.
 */
export function orderWorkbenchRows(
  channels: readonly Channel[],
): readonly Channel[] {
  return [
    ...channels.filter((channel) => channel.pinned),
    ...channels.filter((channel) => !channel.pinned),
  ];
}

/**
 * One workbench row — avatar, name (the agent's for an agent conversation,
 * the row's own title for a multi-party one), optional shared/live, optional
 * time + unread badge, hover menu for rename / pin. Mutations go through
 * `PATCH /channels/:id/settings`.
 */
function WorkbenchRow({
  channel,
  active,
  tenantId,
  onSelect,
  signals = {},
}: {
  readonly channel: Channel;
  readonly active: boolean;
  readonly tenantId: string;
  readonly onSelect: () => void;
  readonly signals?: WorkbenchRowSignals;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(channel.title);
  // The channel prop only reconciles on a scope change, so the effective
  // pinned state lives here: without it a second toggle would re-send and
  // re-announce the first one's transition.
  const [pinned, setPinned] = useState(channel.pinned);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(channel.title);
  const [renameLabel, pinToggleLabel] = rowMenuLabels({ pinned });

  function startRename() {
    setRenameValue(title);
    setRenaming(true);
  }

  useEffect(() => {
    function onRenameRequest(event: Event) {
      if (isChannelRenameRequestFor(event, channel.id)) startRename();
    }
    window.addEventListener(REQUEST_CHANNEL_RENAME_EVENT, onRenameRequest);
    return () =>
      window.removeEventListener(REQUEST_CHANNEL_RENAME_EVENT, onRenameRequest);
  }, [channel.id]);

  async function commitRename() {
    const payload = renamePayload(renameValue, title);
    setRenaming(false);
    if (payload === undefined) return;
    setTitle(payload);
    try {
      await patchChannelSettings(tenantId, channel.id, {
        "chat/name": payload,
      });
      void queryClient.invalidateQueries({
        queryKey: channelsQueryKeyPrefix(tenantId),
      });
      toast(CHAT_STRINGS.channelRenamedToast(payload));
    } catch {
      // Revert the optimistic title on failure; the list will refetch on
      // the next scope selection and reconcile either way.
      setTitle(channel.title);
    }
  }

  function handleRenameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitRename();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setRenaming(false);
    }
  }

  async function togglePinned() {
    const next = !pinned;
    try {
      await patchChannelSettings(tenantId, channel.id, {
        "chat/pinned": next,
      });
      void queryClient.invalidateQueries({
        queryKey: channelsQueryKeyPrefix(tenantId),
      });
      setPinned(next);
      toast(CHAT_STRINGS.channelPinnedToast(next, title));
    } catch {
      toast(CHAT_STRINGS.channelPinToggleError(next));
    }
  }

  if (renaming) {
    return (
      <Input
        autoFocus
        value={renameValue}
        aria-label={CHAT_STRINGS.rowMenuRename}
        onChange={(event) =>
          setRenameValue((event.target as HTMLInputElement).value)
        }
        onKeyDown={handleRenameKeyDown}
        onBlur={() => void commitRename()}
      />
    );
  }

  const displayTitle = title || CHAT_STRINGS.unnamedChannel;
  const faces = channel.participants.slice(0, 1);
  const { sharedLabel, live, time, unread } = signals;
  const hasUnread = typeof unread === "number" && unread > 0;

  return (
    <div
      className="shell-ch-row-wrap"
      data-ctx-channel={channel.id}
      data-ctx-channel-title={displayTitle}
      data-ctx-channel-pinned={channel.pinned ? "true" : "false"}
    >
      <button
        type="button"
        className="shell-ch-row"
        aria-current={active ? "true" : undefined}
        data-active={active ? "true" : undefined}
        onClick={onSelect}
      >
        <span className="shell-ch-stack" aria-hidden="true">
          {faces.length === 0 ? (
            <span>{displayTitle.slice(0, 1).toUpperCase()}</span>
          ) : (
            faces.map((p) => (
              <span
                key={p.address}
                data-agent={
                  p.address.includes("agent") || p.address.includes("ins_")
                    ? "true"
                    : undefined
                }
                data-ctx-profile-address={p.address}
                data-ctx-profile-handle={p.handle}
              >
                {p.handle.slice(0, 1).toUpperCase()}
              </span>
            ))
          )}
        </span>
        <span className="shell-ch-meta">
          <span className="shell-ch-name-row">
            <span className="shell-ch-name">{displayTitle}</span>
            {sharedLabel !== undefined && sharedLabel !== "" ? (
              <Badge tone="shared" title={sharedLabel}>
                shared
              </Badge>
            ) : null}
            {/* Live pulse only when no unread badge. */}
            {live === true && !hasUnread ? (
              <span className="shell-ch-live" title="Active" />
            ) : null}
          </span>
        </span>
        <span className="shell-ch-right">
          {time !== undefined && time !== "" ? (
            <span className="shell-ch-time">{time}</span>
          ) : null}
          {hasUnread ? <Badge tone="accent">{unread}</Badge> : null}
        </span>
      </button>
      <div className="shell-ch-row-menu">
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              className="chat-sidebar-row-menu-trigger"
              aria-label={CHAT_STRINGS.rowMenuLabel}
            >
              <MoreHorizontal />
            </button>
          </MenuTrigger>
          <MenuContent align="start">
            <MenuItem onSelect={startRename}>{renameLabel}</MenuItem>
            <MenuItem onSelect={() => void togglePinned()}>
              {pinToggleLabel}
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </div>
  );
}

export function WorkbenchList({
  path,
  onNavigate,
}: {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
}) {
  const { selectedTenantId } = useBench();
  const activity = useBenchActivity(selectedTenantId);
  const activeId = channelIdFromPath(path);
  const [query, setQuery] = useState("");

  if (activity.kind === "loading") {
    return <Skeleton className="shell-activity-skeleton" />;
  }
  if (activity.kind === "empty") {
    return (
      <EmptyState
        icon={<Hash />}
        title="Nothing selected"
        description="Pick a workbench from the switcher below to get started."
      />
    );
  }
  if (activity.kind === "error") {
    return (
      <EmptyState
        icon={<Hash />}
        title="Couldn't load workbenches"
        description={activity.message}
      />
    );
  }

  const all = orderWorkbenchRows([...activity.channels, ...activity.chats]);
  const workingGroup =
    activity.workingTasks.length > 0 ? (
      <div className="panel-stack-group">
        <p className="panel-band-subheading">Working</p>
        {activity.workingTasks.map((task) => (
          <WorkingTaskRow
            key={task.id}
            task={task}
            onSelect={() => onNavigate("/inbox")}
          />
        ))}
      </div>
    ) : null;

  if (all.length === 0) {
    return (
      <div className="panel-stack" aria-label="Workbenches">
        {workingGroup}
        <h2 className="shell-panel-list-label">Workbenches</h2>
        <div className="panel-stack-group">
          {/* CL-6124: the first-run screen (`/`) IS the "create a
              workbench" surface now — a chat, not a dialog — so this row
              only names it, styled as the already-active row per house
              rule (grey structure, orange edge for "here"). Selecting it
              is a no-op: it names where the person already is. */}
          <button
            type="button"
            className="shell-ch-row"
            data-active="true"
            aria-current="true"
          >
            <span className="shell-ch-stack" aria-hidden="true">
              <span>N</span>
            </span>
            <span className="shell-ch-meta">
              <span className="shell-ch-name-row">
                <span className="shell-ch-name">New Workbench</span>
              </span>
            </span>
            <span className="shell-ch-right" />
          </button>
        </div>
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const filtered =
    q === ""
      ? all
      : all.filter((channel) => {
          const name = (
            channel.title || CHAT_STRINGS.unnamedChannel
          ).toLowerCase();
          return name.includes(q);
        });

  const tenantId = selectedTenantId ?? "";

  return (
    <div className="panel-stack" aria-label="Workbenches">
      {workingGroup}
      <label className="shell-panel-search">
        <Search aria-hidden="true" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search…"
          aria-label="Search workbenches"
        />
      </label>
      <h2 className="shell-panel-list-label">Workbenches</h2>
      {filtered.length === 0 ? (
        <EmptyState
          icon={<MessageSquare />}
          title="No matches"
          description={`Nothing matches “${query.trim()}”.`}
        />
      ) : (
        <div className="panel-stack-group">
          {filtered.map((channel) => (
            <WorkbenchRow
              key={channel.id}
              channel={channel}
              active={channel.id === activeId}
              tenantId={tenantId}
              onSelect={() => onNavigate(channelPath(channel.id))}
              signals={workbenchRowSignals(channel, channel.id === activeId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
