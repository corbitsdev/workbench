// The sidebar's one list: every workbench (an agent conversation, each its
// own tenancy under the hood) as a flat run of rows — no kind sections, no
// per-page variants. Pinned rows float to the top; everything else keeps
// the order the platform returns.

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
import type { Workbench } from "@corbits/chat-ui";
import { useQueryClient } from "@tanstack/react-query";
import { ChatCircle, DotsThree, Hash, MagnifyingGlass } from "@corbits/icons";
import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";

import { useNeedsYouCount } from "../api";
import { useBench } from "../bench-context";
import { workbenchIdFromPath, workbenchPath } from "../workbench-path";
import {
  REQUEST_WORKBENCH_RENAME_EVENT,
  isWorkbenchRenameRequestFor,
} from "../workbench-rename-events";
import { useBenchActivity } from "./bench-activity";
import { Chip } from "./chip";
import { buildSidebarRows, type SidebarRow } from "./sidebar-rows";

/**
 * The bench-wide "something needs you" signal above the row list. The
 * `/approvals/needs-you` read is scoped to the selected bench already, but
 * carries no per-workbench id (a known v1 gap — see
 * `workbench-timeline-merge.ts`'s `toApprovalEvents` doc), so this renders
 * once for the whole list rather than guessing which row it belongs to.
 */
function NeedsYouSignal({ tenantId }: { readonly tenantId: string | null }) {
  const count = useNeedsYouCount(tenantId);
  if (count === null || count <= 0) return null;
  return (
    <div className="shell-panel-needs-you">
      <span>{count} waiting on you</span>
      <Chip tone="needs-you">Needs you</Chip>
    </div>
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
              <DotsThree />
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
  const activeId = workbenchIdFromPath(path);
  const [query, setQuery] = useState("");

  if (activity.kind === "loading") {
    return (
      <div className="shell-activity-skeleton-rows" aria-hidden="true">
        <Skeleton className="shell-activity-skeleton-row" />
        <Skeleton className="shell-activity-skeleton-row" />
        <Skeleton className="shell-activity-skeleton-row" />
        <Skeleton className="shell-activity-skeleton-row" />
      </div>
    );
  }
  if (activity.kind === "empty") {
    return (
      <EmptyState
        icon={<Hash />}
        title="No workbenches yet"
        description="Start a new one with the + above."
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

  const all = buildSidebarRows(activity.workbenches, activity.chats);

  if (all.length === 0) {
    return (
      <div className="panel-stack" aria-label="Workbenches">
        <NeedsYouSignal tenantId={selectedTenantId} />
        <EmptyState
          icon={<Hash />}
          title="No workbenches yet"
          description="Start a new one with the + above."
        />
      </div>
    );
  }

  const rowName = (row: SidebarRow): string =>
    displayWorkbenchTitle(row.workbench.title, row.workbench.id) ||
    CHAT_STRINGS.unnamedWorkbench;

  const q = query.trim().toLowerCase();
  const filtered =
    q === ""
      ? all
      : all.filter((row) => rowName(row).toLowerCase().includes(q));

  const tenantId = selectedTenantId ?? "";

  return (
    <div className="panel-stack" aria-label="Workbenches">
      <label className="shell-panel-search">
        <MagnifyingGlass aria-hidden="true" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search…"
          aria-label="Search workbenches"
        />
      </label>
      <NeedsYouSignal tenantId={selectedTenantId} />
      <h2 className="shell-panel-list-label">Workbenches</h2>
      {filtered.length === 0 ? (
        <EmptyState
          icon={<ChatCircle />}
          title="No matches"
          description={`Nothing matches “${query.trim()}”.`}
        />
      ) : (
        <div className="panel-stack-group">
          {filtered.map((row) => (
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
          ))}
        </div>
      )}
    </div>
  );
}
