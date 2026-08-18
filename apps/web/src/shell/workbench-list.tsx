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
import type { Channel, VisibleAgentDefinition } from "@corbits/chat-ui";
import { WorkingTaskRow } from "@corbits/tasks-ui";
import { useQueryClient } from "@tanstack/react-query";
import { Hash, MessageSquare, MoreHorizontal, Search } from "lucide-react";
import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";

import { openAgentDmChat } from "../agent-dm-launch";
import { useBench } from "../bench-context";
import { channelIdFromPath, channelPath } from "../channel-path";
import {
  REQUEST_CHANNEL_RENAME_EVENT,
  isChannelRenameRequestFor,
} from "../channel-rename-events";
import { useBenchActivity } from "./bench-activity";
import {
  buildSidebarRows,
  identityColorClass,
  type SidebarRow,
} from "./sidebar-rows";

/**
 * The always-active, no-op row naming the current screen as "where the
 * person already is" (CL-6124) while a brand-new bench's zero-workbench
 * `/` land is auto-minting its first Myra workbench (CL-6138) — a
 * transient state, but one that still deserves an honest sidebar row
 * rather than an empty list. Styled as the already-active row per house
 * rule (grey structure, orange edge for "here"); selecting it is a no-op
 * since it names the current screen, not a destination.
 */
function NewWorkbenchStubRow() {
  return (
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
  );
}

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
 * Flat ordering for the one list: pinned rows first, then most-recent
 * activity first within each half. Missing timestamps sort last but keep
 * their given relative order (stable sort). Pure so the "no kind sections"
 * and "recency, not insertion order" rules are testable.
 */
export function orderWorkbenchRows(
  channels: readonly Channel[],
): readonly Channel[] {
  const byRecency = (a: Channel, b: Channel) => {
    const at = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
    const bt = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
    return bt - at;
  };
  return [
    ...channels.filter((channel) => channel.pinned).sort(byRecency),
    ...channels.filter((channel) => !channel.pinned).sort(byRecency),
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
        {/* The workbench's own initial, not its agent's — every bench
            hosts Myra, so an agent monogram renders an identical "M"
            column that says nothing. */}
        <span className="shell-ch-stack" aria-hidden="true">
          <span>{displayTitle.slice(0, 1).toUpperCase()}</span>
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
          {channel.preview !== undefined && channel.preview !== "" ? (
            <span className="shell-ch-preview">{channel.preview}</span>
          ) : null}
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

/**
 * A never-opened agent's row (CL-6253): mints its DM lazily on first
 * click, then reuses the same channel on every later click — once
 * opened, the agent shows up as an ordinary channel row via its own DM
 * `Channel` instead (see `unopenedAgentRows`). Disabled, with an honest
 * join caption, when the caller isn't a member of the agent's OWNING
 * tenant — reachable-through-inheritance is not the same as postable-in;
 * see `packages/agent-directory/src/visible-definitions.ts`.
 */
function AgentRow({
  agent,
  isMember,
  onNavigate,
}: {
  readonly agent: VisibleAgentDefinition;
  readonly isMember: boolean;
  readonly onNavigate: (to: string) => void;
}) {
  const [opening, setOpening] = useState(false);
  const disabled = !isMember || opening;

  async function handleSelect() {
    if (disabled) return;
    setOpening(true);
    try {
      await openAgentDmChat(agent.tenantId, agent.id, onNavigate);
    } catch {
      toast(CHAT_STRINGS.agentDmOpenError(agent.name));
    } finally {
      setOpening(false);
    }
  }

  const colorClass = identityColorClass(agent.name);

  return (
    <div className="shell-ch-row-wrap" data-ctx-agent={agent.id}>
      <button
        type="button"
        className="shell-ch-row"
        disabled={disabled}
        aria-disabled={disabled ? "true" : undefined}
        onClick={() => void handleSelect()}
      >
        <span className="shell-ch-stack" aria-hidden="true">
          <span className={`shell-agent-avatar ${colorClass}`}>
            {agent.name.slice(0, 1).toUpperCase()}
          </span>
        </span>
        <span className="shell-ch-meta">
          <span className="shell-ch-name-row">
            <span className="shell-ch-name">{agent.name}</span>
          </span>
          {!isMember ? (
            <span className="shell-ch-preview">
              Lives in {agent.tenantName} — join it to chat
            </span>
          ) : null}
        </span>
        <span className="shell-ch-right" />
      </button>
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
  const { selectedTenantId, memberships } = useBench();
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

  const all = buildSidebarRows(
    activity.channels,
    activity.chats,
    activity.agents,
  );
  const memberTenantIds =
    memberships.kind === "ready"
      ? new Set(memberships.data.data.map((m) => m.tenantId))
      : new Set<string>();
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
          <NewWorkbenchStubRow />
        </div>
      </div>
    );
  }

  const rowName = (row: SidebarRow): string =>
    row.kind === "channel"
      ? row.channel.title || CHAT_STRINGS.unnamedChannel
      : row.agent.name;

  const q = query.trim().toLowerCase();
  const filtered =
    q === "" ? all : all.filter((row) => rowName(row).toLowerCase().includes(q));

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
          {filtered.map((row) =>
            row.kind === "channel" ? (
              <WorkbenchRow
                key={row.channel.id}
                channel={row.channel}
                active={row.channel.id === activeId}
                tenantId={tenantId}
                onSelect={() => onNavigate(channelPath(row.channel.id))}
                signals={workbenchRowSignals(
                  row.channel,
                  row.channel.id === activeId,
                )}
              />
            ) : (
              <AgentRow
                key={row.agent.id}
                agent={row.agent}
                isMember={memberTenantIds.has(row.agent.tenantId)}
                onNavigate={onNavigate}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}
