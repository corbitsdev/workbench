// Registers each page's contextual-panel contribution. Imported once from
// the shell so matchers are on the registry before first render.

import {
  EmptyState,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  SidebarItemRow,
  Skeleton,
  toast,
} from "@corbits/react-ui";
import { isAgentAddress } from "@corbits/chat/mentions";
import { CHAT_STRINGS, patchChannelSettings } from "@corbits/chat-ui";
import type { Channel } from "@corbits/chat-ui";
import {
  Bell,
  Hash,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";

import { useAPIQuery } from "../api";
import { useBench } from "../bench-context";
import { channelIdFromPath, channelPath, isChannelPath } from "../channel-path";
import {
  REQUEST_CHANNEL_RENAME_EVENT,
  isChannelRenameRequestFor,
} from "../channel-rename-events";
import { InboxCountsSchema, inboxCountsPath } from "../inbox-api";
import { requestLibraryUpload } from "../library-upload";
import { useBenchActivity } from "./bench-activity";
import { InsightsViewsBand } from "./insights-band";
import { LibraryKindBand } from "./library-band";
import {
  registerPanelContribution,
  type PanelRenderContext,
} from "./panel-contribution";
import { RoutinesFeedBand } from "./routines-feed-band";
import { SettingsNavBand } from "./settings-nav-band";

function pathMatches(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The ellipsis-menu item labels for a panel channel row. The panel's row menu
 * carries only the two affordances that don't need the full settings dialog —
 * rename and the pin/unpin "archive" toggle — so this is a strict subset of
 * the chat sidebar's three-item menu. Pure so the pinned-state wording
 * ("Pin" vs "Unpin") is testable without opening the (portaled, Radix)
 * menu. Pinning is the closest the settings PATCH (`chat/pinned`) gets to an
 * archive affordance; there is no separate archive endpoint.
 */
export function panelRowMenuLabels(
  channel: Pick<Channel, "pinned">,
): readonly [rename: string, archive: string] {
  return [
    CHAT_STRINGS.rowMenuRename,
    channel.pinned ? CHAT_STRINGS.rowMenuUnpin : CHAT_STRINGS.rowMenuPin,
  ];
}

/**
 * What a rename submission should send: `undefined` for input that resolves
 * to nothing worth saving (blank, or unchanged from the channel's current
 * title) — the caller's cue to treat the rename as a no-op cancel rather
 * than firing an empty-name PATCH. Mirrors the chat sidebar's helper.
 */
export function panelRenamePayload(
  input: string,
  currentTitle: string,
): string | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed === currentTitle) return undefined;
  return trimmed;
}

/**
 * The read-only detail lines a "channel details" panel contribution prints
 * for the selected channel — name, kind, and pinned state. Pure so the
 * mapping is testable without rendering.
 */
export function channelDetails(
  channel: Pick<Channel, "title" | "kind" | "pinned">,
): {
  readonly title: string;
  readonly kind: string;
  readonly pinned: boolean;
} {
  return {
    title: channel.title || CHAT_STRINGS.unnamedChannel,
    kind: channel.kind,
    pinned: channel.pinned,
  };
}

/**
 * Optional row signals the mock shows (shared / live / time / unread). The
 * channel wire today only carries id/title/kind/pinned/participants — so these
 * stay undefined until the list API grows them. Render only when present; never
 * invent counts or timestamps.
 */
type ChannelRowSignals = {
  readonly sharedLabel?: string;
  readonly live?: boolean;
  readonly time?: string;
  readonly unread?: number;
};

/**
 * One channel row in the panel list — mock-dense nav row: avatar stack, name,
 * optional shared/live, optional time + unread badge, hover menu for rename /
 * pin. Mutations go through `PATCH /channels/:id/settings`.
 */
function ChannelPanelRow({
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
  readonly signals?: ChannelRowSignals;
}) {
  const [title, setTitle] = useState(channel.title);
  // The channel prop only reconciles on bench change, so the effective
  // pinned state lives here: without it a second toggle would re-send and
  // re-announce the first one's transition.
  const [pinned, setPinned] = useState(channel.pinned);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(channel.title);
  const [renameLabel, archiveLabel] = panelRowMenuLabels({ pinned });

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
    const payload = panelRenamePayload(renameValue, title);
    setRenaming(false);
    if (payload === undefined) return;
    setTitle(payload);
    try {
      await patchChannelSettings(tenantId, channel.id, {
        "chat/name": payload,
      });
      toast(CHAT_STRINGS.channelRenamedToast(payload));
    } catch {
      // Revert the optimistic title on failure; the band will refetch on the
      // next bench selection and reconcile either way.
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
      setPinned(next);
      toast(CHAT_STRINGS.channelPinnedToast(next, title));
    } catch {
      // Best-effort: the band refetches on bench change and reconciles.
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
              <span className="shell-ch-shared-badge" title={sharedLabel}>
                shared
              </span>
            ) : null}
            {/* Mock: live pulse only when no unread badge. */}
            {live === true && !hasUnread ? (
              <span className="shell-ch-live" title="Active" />
            ) : null}
          </span>
        </span>
        <span className="shell-ch-right">
          {time !== undefined && time !== "" ? (
            <span className="shell-ch-time">{time}</span>
          ) : null}
          {hasUnread ? <span className="shell-ch-badge">{unread}</span> : null}
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
              {archiveLabel}
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </div>
  );
}

/**
 * Tenancy-shaped sidebar buckets (not activity-shaped). Pinned and External
 * stay hidden until they have rows; Internal/Agents/DMs always show once any
 * channels exist. External has no wire flag yet, so it stays empty until
 * shared-channel metadata lands.
 */
type ChannelBucketId = "pinned" | "agents" | "internal" | "external" | "dms";

const CHANNEL_BUCKETS: readonly {
  readonly id: ChannelBucketId;
  readonly label: string;
  readonly hideWhenEmpty: boolean;
}[] = [
  { id: "pinned", label: "Pinned", hideWhenEmpty: true },
  { id: "agents", label: "Agents", hideWhenEmpty: false },
  { id: "internal", label: "Internal", hideWhenEmpty: false },
  { id: "external", label: "External · shared", hideWhenEmpty: true },
  { id: "dms", label: "DMs", hideWhenEmpty: false },
];

/** Pure bucket assignment for a channel row — testable without rendering. */
export function assignChannelBucket(channel: Channel): ChannelBucketId {
  if (channel.pinned) return "pinned";
  if (channel.kind === "chat") {
    const hasAgent = channel.participants.some((participant) =>
      isAgentAddress(participant.address),
    );
    return hasAgent ? "agents" : "dms";
  }
  return "internal";
}

function ChannelsBand({
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
        title="No bench selected"
        description="Choose a bench from the rail to see its channels."
      />
    );
  }
  if (activity.kind === "error") {
    return (
      <EmptyState
        icon={<Hash />}
        title="Couldn't load channels"
        description={activity.message}
      />
    );
  }

  const all = [...activity.channels, ...activity.chats];
  if (all.length === 0) {
    return (
      <EmptyState
        icon={<MessageSquare />}
        title="No channels yet"
        description="Create a channel to start a conversation."
      />
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

  const byBucket = new Map<ChannelBucketId, Channel[]>();
  for (const bucket of CHANNEL_BUCKETS) {
    byBucket.set(bucket.id, []);
  }
  for (const channel of filtered) {
    const id = assignChannelBucket(channel);
    byBucket.get(id)?.push(channel);
  }

  const hasVisibleRows = filtered.length > 0;

  return (
    <div className="panel-stack" aria-label="Channels">
      <label className="shell-panel-search">
        <Search aria-hidden="true" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search…"
          aria-label="Search channels"
        />
      </label>
      {!hasVisibleRows ? (
        <EmptyState
          icon={<MessageSquare />}
          title="No matching channels"
          description={`Nothing matches “${query.trim()}”.`}
        />
      ) : (
        CHANNEL_BUCKETS.map((bucket) => {
          const rows = byBucket.get(bucket.id) ?? [];
          if (rows.length === 0 && bucket.hideWhenEmpty) return null;
          if (rows.length === 0) return null;
          return (
            <div key={bucket.id} className="panel-stack-group">
              <p className="panel-band-subheading">{bucket.label}</p>
              {rows.map((channel) => (
                <ChannelPanelRow
                  key={channel.id}
                  channel={channel}
                  active={channel.id === activeId}
                  tenantId={tenantId}
                  onSelect={() => onNavigate(channelPath(channel.id))}
                />
              ))}
            </div>
          );
        })
      )}
    </div>
  );
}

const INBOX_FILTERS: readonly {
  id: "all" | "action" | "mention" | "delivery";
  label: string;
  countKey: "open" | "action" | "mention" | "delivery" | null;
}[] = [
  { id: "all", label: "Everything", countKey: "open" },
  { id: "action", label: "Needs action", countKey: "action" },
  { id: "mention", label: "Mentions", countKey: "mention" },
  { id: "delivery", label: "Deliveries", countKey: "delivery" },
];

export function inboxFilterFromPath(
  path: string,
): "all" | "action" | "mention" | "delivery" {
  const segment = path.replace(/^\/inbox\/?/, "").split("/")[0] ?? "";
  if (segment === "action" || segment === "mention" || segment === "delivery") {
    return segment;
  }
  return "all";
}

export function inboxPathForFilter(
  group: "all" | "action" | "mention" | "delivery",
): string {
  return group === "all" ? "/inbox" : `/inbox/${group}`;
}

function InboxFiltersBand({
  path,
  onNavigate,
}: {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
}) {
  const { selectedTenantId } = useBench();
  const countsQuery = useAPIQuery(
    selectedTenantId === null ? "" : inboxCountsPath(selectedTenantId),
    InboxCountsSchema,
  );
  const counts = countsQuery.kind === "ready" ? countsQuery.data : null;
  const active = inboxFilterFromPath(path);

  return (
    <div className="panel-stack" aria-label="Inbox filters">
      {INBOX_FILTERS.map((filter) => {
        const n =
          counts === null || filter.countKey === null
            ? null
            : counts[filter.countKey];
        return (
          <div key={filter.id} data-ctx-inbox-filter={filter.id}>
            <SidebarItemRow
              name={filter.label}
              meta={n === null ? undefined : String(n)}
              selected={active === filter.id}
              onSelect={() => onNavigate(inboxPathForFilter(filter.id))}
            />
          </div>
        );
      })}
    </div>
  );
}

function LiveActivityBand({
  path,
  onNavigate,
}: {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
}) {
  // Home and other surfaces share the live pulse: channels + running routines.
  const { selectedTenantId } = useBench();
  const activity = useBenchActivity(selectedTenantId);
  const activeId = channelIdFromPath(path);

  if (activity.kind === "loading") {
    return <Skeleton className="shell-activity-skeleton" />;
  }
  if (activity.kind === "empty") {
    return (
      <EmptyState
        icon={<Hash />}
        title="No bench selected"
        description="Choose a bench from the rail to see live activity."
      />
    );
  }
  if (activity.kind === "error") {
    return (
      <EmptyState
        icon={<Hash />}
        title="Couldn't load activity"
        description={activity.message}
      />
    );
  }

  const hasAnything =
    activity.channels.length > 0 ||
    activity.chats.length > 0 ||
    activity.routines.length > 0;

  if (!hasAnything) {
    return (
      <EmptyState
        icon={<Bell />}
        title="Quiet right now"
        description="Channels and running routines for this bench will appear here."
      />
    );
  }

  const tenantId = selectedTenantId ?? "";

  return (
    <div className="panel-stack">
      {activity.routines.length > 0 ? (
        <div className="panel-stack-group">
          <p className="panel-band-subheading">Running</p>
          {activity.routines.map((routine) => (
            <SidebarItemRow
              key={routine.id}
              name={routine.name}
              meta={routine.status}
              onSelect={() => onNavigate("/routines")}
            />
          ))}
        </div>
      ) : null}
      {activity.channels.length > 0 ? (
        <div className="panel-stack-group">
          <p className="panel-band-subheading">Channels</p>
          {activity.channels.map((channel) => (
            <ChannelPanelRow
              key={channel.id}
              channel={channel}
              active={channel.id === activeId}
              tenantId={tenantId}
              onSelect={() => onNavigate(`${channelPath(channel.id)}`)}
            />
          ))}
        </div>
      ) : null}
      {activity.chats.length > 0 ? (
        <div className="panel-stack-group">
          <p className="panel-band-subheading">Chats</p>
          {activity.chats.map((channel) => (
            <ChannelPanelRow
              key={channel.id}
              channel={channel}
              active={channel.id === activeId}
              tenantId={tenantId}
              onSelect={() => onNavigate(`${channelPath(channel.id)}`)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function defaultBand(title: string, settingsPath?: string) {
  return (_ctx: PanelRenderContext) => ({
    title,
    ...(settingsPath !== undefined ? { settingsPath } : {}),
  });
}

let registered = false;

/** Idempotent — safe to call from the shell on every module load. */
export function ensurePanelContributions(): void {
  if (registered) return;
  registered = true;

  registerPanelContribution({
    id: "home",
    match: (path) => path === "/",
    pageBand: defaultBand("Myra"),
    pageSpecific: (ctx) => (
      <LiveActivityBand path={ctx.path} onNavigate={ctx.onNavigate} />
    ),
  });

  registerPanelContribution({
    id: "channels",
    match: (path) => isChannelPath(path),
    pageBand: (ctx) => {
      return {
        // Header title must stay a string for SidebarPanelHeader (react-ui pin).
        title: "Channels",
        headerActions: [
          {
            id: "new-channel",
            label: "New channel",
            icon: <Plus />,
            onSelect: () => {
              window.dispatchEvent(
                new CustomEvent("workbench:chat:new-channel"),
              );
              if (!isChannelPath(ctx.path)) ctx.onNavigate(channelPath(null));
            },
          },
        ],
      };
    },
    pageSpecific: (ctx) => (
      <ChannelsBand path={ctx.path} onNavigate={ctx.onNavigate} />
    ),
  });

  registerPanelContribution({
    id: "inbox",
    match: (path) => pathMatches("/inbox", path),
    pageBand: defaultBand("Inbox"),
    pageSpecific: (ctx) => (
      <InboxFiltersBand path={ctx.path} onNavigate={ctx.onNavigate} />
    ),
  });

  registerPanelContribution({
    id: "routines",
    match: (path) => pathMatches("/routines", path),
    pageBand: (ctx) => ({
      title: "Routines",
      headerActions: [
        {
          id: "create-routine",
          label: "Create routine",
          icon: <Plus />,
          onSelect: () => {
            window.dispatchEvent(new CustomEvent("workbench:routines:create"));
            if (!pathMatches("/routines", ctx.path))
              ctx.onNavigate("/routines");
          },
        },
      ],
    }),
    pageSpecific: (ctx) => (
      <RoutinesFeedBand path={ctx.path} onNavigate={ctx.onNavigate} />
    ),
  });

  registerPanelContribution({
    id: "library",
    match: (path) => pathMatches("/library", path),
    pageBand: (ctx) => ({
      title: "Library",
      headerActions: [
        {
          id: "upload-artifact",
          label: "Upload",
          icon: <Plus />,
          onSelect: () => {
            requestLibraryUpload({
              alreadyOnLibrary: pathMatches("/library", ctx.path),
              navigateToLibrary: () => ctx.onNavigate("/library"),
            });
          },
        },
      ],
      // Mock's Library qaStrip: jump to where artifacts come from.
      actions: [
        {
          id: "library-qa-channels",
          label: "Channels",
          onSelect: () => ctx.onNavigate(channelPath(null)),
        },
        {
          id: "library-qa-routines",
          label: "Routines",
          onSelect: () => ctx.onNavigate("/routines"),
        },
      ],
    }),
    pageSpecific: (ctx) => (
      <LibraryKindBand path={ctx.path} onNavigate={ctx.onNavigate} />
    ),
  });

  registerPanelContribution({
    id: "insights",
    match: (path) => pathMatches("/insights", path),
    pageBand: defaultBand("Insights"),
    pageSpecific: (ctx) => (
      <InsightsViewsBand path={ctx.path} onNavigate={ctx.onNavigate} />
    ),
  });

  registerPanelContribution({
    id: "settings",
    match: (path) => pathMatches("/settings", path),
    pageBand: defaultBand("Settings"),
    pageSpecific: (ctx) => (
      <SettingsNavBand path={ctx.path} onNavigate={ctx.onNavigate} />
    ),
  });

  registerPanelContribution({
    id: "benches",
    match: (path) => pathMatches("/benches", path),
    pageBand: defaultBand("Benches"),
  });
}
