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
  displayWorkbenchTitle,
  workbenchesQueryKeyPrefix,
  patchWorkbenchSettings,
} from "@corbits/chat-ui";
import type { Workbench, VisibleAgentDefinition } from "@corbits/chat-ui";
import { WorkingTaskRow } from "@corbits/tasks-ui";
import { useQueryClient } from "@tanstack/react-query";
import { Hash, MessageSquare, MoreHorizontal, Search } from "lucide-react";
import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";

import { openAgentDmChat } from "../agent-dm-launch";
import { useBench } from "../bench-context";
import { workbenchIdFromPath, workbenchPath } from "../workbench-path";
import {
  REQUEST_WORKBENCH_RENAME_EVENT,
  isWorkbenchRenameRequestFor,
} from "../workbench-rename-events";
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
  workbench: Pick<Workbench, "pinned">,
): readonly [rename: string, pinToggle: string] {
  return [
    CHAT_STRINGS.rowMenuRename,
    workbench.pinned ? CHAT_STRINGS.rowMenuUnpin : CHAT_STRINGS.rowMenuPin,
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
  workbench: Pick<
    Workbench,
    "unreadCount" | "lastActivityAt" | "live" | "sharedLabel"
  >,
  isOpen: boolean,
): WorkbenchRowSignals {
  return {
    ...(workbench.sharedLabel !== undefined
      ? { sharedLabel: workbench.sharedLabel }
      : {}),
    ...(workbench.live !== undefined ? { live: workbench.live } : {}),
    ...(workbench.lastActivityAt !== undefined
      ? { time: formatRelativeTime(workbench.lastActivityAt) }
      : {}),
    ...(workbench.unreadCount !== undefined
      ? { unread: isOpen ? 0 : workbench.unreadCount }
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
  workbenches: readonly Workbench[],
): readonly Workbench[] {
  const byRecency = (a: Workbench, b: Workbench) => {
    const at = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
    const bt = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
    return bt - at;
  };
  return [
    ...workbenches.filter((workbench) => workbench.pinned).sort(byRecency),
    ...workbenches.filter((workbench) => !workbench.pinned).sort(byRecency),
  ];
}

/**
 * One workbench row — avatar, name (the agent's for an agent conversation,
 * the row's own title for a multi-party one), optional shared/live, optional
 * time + unread badge, hover menu for rename / pin. Mutations go through
 * `PATCH /workbenches/:id/settings`.
 */
function WorkbenchRow({
  workbench,
  active,
  tenantId,
  onSelect,
  signals = {},
}: {
  readonly workbench: Workbench;
  readonly active: boolean;
  readonly tenantId: string;
  readonly onSelect: () => void;
  readonly signals?: WorkbenchRowSignals;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(workbench.title);
  // The workbench prop only reconciles on a scope change, so the effective
  // pinned state lives here: without it a second toggle would re-send and
  // re-announce the first one's transition.
  const [pinned, setPinned] = useState(workbench.pinned);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(workbench.title);
  const [renameLabel, pinToggleLabel] = rowMenuLabels({ pinned });

  function startRename() {
    setRenameValue(title);
    setRenaming(true);
  }

  useEffect(() => {
    function onRenameRequest(event: Event) {
      if (isWorkbenchRenameRequestFor(event, workbench.id)) startRename();
    }
    window.addEventListener(REQUEST_WORKBENCH_RENAME_EVENT, onRenameRequest);
    return () =>
      window.removeEventListener(
        REQUEST_WORKBENCH_RENAME_EVENT,
        onRenameRequest,
      );
  }, [workbench.id]);

  async function commitRename() {
    const payload = renamePayload(renameValue, title);
    setRenaming(false);
    if (payload === undefined) return;
    setTitle(payload);
    try {
      await patchWorkbenchSettings(tenantId, workbench.id, {
        "chat/name": payload,
      });
      void queryClient.invalidateQueries({
        queryKey: workbenchesQueryKeyPrefix(tenantId),
      });
      toast(CHAT_STRINGS.workbenchRenamedToast(payload));
    } catch {
      // Revert the optimistic title on failure; the list will refetch on
      // the next scope selection and reconcile either way.
      setTitle(workbench.title);
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
      await patchWorkbenchSettings(tenantId, workbench.id, {
        "chat/pinned": next,
      });
      void queryClient.invalidateQueries({
        queryKey: workbenchesQueryKeyPrefix(tenantId),
      });
      setPinned(next);
      toast(CHAT_STRINGS.workbenchPinnedToast(next, title));
    } catch {
      toast(CHAT_STRINGS.workbenchPinToggleError(next));
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

  const displayTitle =
    displayWorkbenchTitle(title, workbench.id) || CHAT_STRINGS.unnamedWorkbench;
  const { sharedLabel, live, time, unread } = signals;
  const hasUnread = typeof unread === "number" && unread > 0;

  return (
    <div
      className="shell-ch-row-wrap"
      data-ctx-workbench={workbench.id}
      data-ctx-workbench-title={displayTitle}
      data-ctx-workbench-pinned={workbench.pinned ? "true" : "false"}
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
          {workbench.preview !== undefined && workbench.preview !== "" ? (
            <span className="shell-ch-preview">{workbench.preview}</span>
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
 * click, then reuses the same workbench on every later click — once
 * opened, the agent shows up as an ordinary workbench row via its own DM
 * `Workbench` instead (see `unopenedAgentRows`). Disabled, with an honest
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
  const activeId = workbenchIdFromPath(path);
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
    activity.workbenches,
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
    row.kind === "workbench"
      ? displayWorkbenchTitle(row.workbench.title, row.workbench.id) ||
        CHAT_STRINGS.unnamedWorkbench
      : row.agent.name;

  const q = query.trim().toLowerCase();
  const filtered =
    q === ""
      ? all
      : all.filter((row) => rowName(row).toLowerCase().includes(q));

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
            row.kind === "workbench" ? (
              <WorkbenchRow
                key={row.workbench.id}
                workbench={row.workbench}
                active={row.workbench.id === activeId}
                tenantId={tenantId}
                onSelect={() => onNavigate(workbenchPath(row.workbench.id))}
                signals={workbenchRowSignals(
                  row.workbench,
                  row.workbench.id === activeId,
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
