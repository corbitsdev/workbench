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
} from "@corbits/react-ui";
import { isAgentAddress } from "@corbits/chat/mentions";
import { CHAT_STRINGS, patchChannelSettings } from "@corbits/chat-ui";
import type { Channel } from "@corbits/chat-ui";
import {
  Bell,
  Hash,
  MessageSquare,
  MoreHorizontal,
  Workflow,
} from "lucide-react";
import { useState } from "react";
import type { KeyboardEvent } from "react";

import { useAPIQuery } from "../api";
import { useBench } from "../bench-context";
import { channelIdFromPath, channelPath, isChannelPath } from "../channel-path";
import { InboxCountsSchema, inboxCountsPath } from "../inbox-api";
import { useBenchActivity } from "./bench-activity";
import { resolveChannelTitle } from "./channel-context";
import {
  registerPanelContribution,
  type PanelRenderContext,
} from "./panel-contribution";
import type { RoutineActivityItem } from "./routine-activity";

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
 * One channel row in the panel list, with a hover-revealed ellipsis menu for
 * rename (inline) and the pin/unpin archive toggle. Both go through the
 * single `PATCH /channels/:id/settings` route via `patchChannelSettings`.
 * The rename keeps a local display title so the row updates the moment the
 * PATCH resolves, without waiting for the band's activity refetch.
 */
function ChannelPanelRow({
  channel,
  active,
  tenantId,
  onSelect,
}: {
  readonly channel: Channel;
  readonly active: boolean;
  readonly tenantId: string;
  readonly onSelect: () => void;
}) {
  const [title, setTitle] = useState(channel.title);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(channel.title);
  const [renameLabel, archiveLabel] = panelRowMenuLabels(channel);

  function startRename() {
    setRenameValue(title);
    setRenaming(true);
  }

  async function commitRename() {
    const payload = panelRenamePayload(renameValue, title);
    setRenaming(false);
    if (payload === undefined) return;
    setTitle(payload);
    try {
      await patchChannelSettings(tenantId, channel.id, {
        "chat/name": payload,
      });
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
    try {
      await patchChannelSettings(tenantId, channel.id, {
        "chat/pinned": !channel.pinned,
      });
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

  return (
    <div className="chat-sidebar-row">
      <button
        type="button"
        className="chat-sidebar-item"
        aria-current={active ? "true" : undefined}
        data-active={active}
        onClick={onSelect}
      >
        <span>{title || CHAT_STRINGS.unnamedChannel}</span>
      </button>
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
  );
}

/**
 * The channel details panel contribution: when a specific channel is open in
 * the canvas, print its name, kind, and pinned state above the channel list
 * so the panel doubles as a details surface without a second fetch. Falls
 * back to nothing when no channel is selected.
 */
function ChannelDetails({ channel }: { readonly channel: Channel }) {
  const details = channelDetails(channel);
  return (
    <div className="panel-stack-group">
      <p className="panel-band-subheading">Details</p>
      <dl className="panel-channel-details">
        <div>
          <dt>Name</dt>
          <dd>{details.title}</dd>
        </div>
        <div>
          <dt>Type</dt>
          <dd>{details.kind}</dd>
        </div>
        <div>
          <dt>Pinned</dt>
          <dd>{details.pinned ? "Yes" : "No"}</dd>
        </div>
      </dl>
    </div>
  );
}

/** Live page-band title for an open channel — falls back while loading. */
function ChannelPageTitle({
  channelId,
  fallback,
}: {
  readonly channelId: string | null;
  readonly fallback: string;
}) {
  const { selectedTenantId } = useBench();
  const activity = useBenchActivity(selectedTenantId);
  const title = resolveChannelTitle(activity, channelId);
  if (title !== null) return title;
  return fallback;
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
  onOpenInCanvas,
}: {
  readonly path: string;
  readonly onOpenInCanvas: (channelId: string) => void;
}) {
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

  const selected =
    activeId === null
      ? undefined
      : all.find((channel) => channel.id === activeId);
  const tenantId = selectedTenantId ?? "";

  const byBucket = new Map<ChannelBucketId, Channel[]>();
  for (const bucket of CHANNEL_BUCKETS) {
    byBucket.set(bucket.id, []);
  }
  for (const channel of all) {
    const id = assignChannelBucket(channel);
    byBucket.get(id)?.push(channel);
  }

  return (
    <div className="panel-stack">
      {selected !== undefined ? <ChannelDetails channel={selected} /> : null}
      {CHANNEL_BUCKETS.map((bucket) => {
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
                onSelect={() => onOpenInCanvas(channel.id)}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function RoutinesFeedBand({
  onNavigate,
}: {
  readonly onNavigate: (to: string) => void;
}) {
  const { selectedTenantId } = useBench();
  const activity = useBenchActivity(selectedTenantId);

  if (activity.kind === "loading") {
    return <Skeleton className="shell-activity-skeleton" />;
  }
  if (activity.kind === "empty") {
    return (
      <EmptyState
        icon={<Workflow />}
        title="No bench selected"
        description="Choose a bench from the rail to see running routines."
      />
    );
  }
  if (activity.kind === "error") {
    return (
      <EmptyState
        icon={<Workflow />}
        title="Couldn't load activity"
        description={activity.message}
      />
    );
  }
  if (activity.routines.length === 0) {
    return (
      <EmptyState
        icon={<Workflow />}
        title="Nothing running"
        description="A routine running in this bench shows up here while it executes."
      />
    );
  }
  return (
    <div className="panel-stack">
      {activity.routines.map((routine: RoutineActivityItem) => (
        <SidebarItemRow
          key={routine.id}
          name={routine.name}
          meta={routine.status}
          onSelect={() => onNavigate(`/routines/${routine.id}`)}
        />
      ))}
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
          <SidebarItemRow
            key={filter.id}
            name={filter.label}
            meta={n === null ? undefined : String(n)}
            selected={active === filter.id}
            onSelect={() => onNavigate(inboxPathForFilter(filter.id))}
          />
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

function defaultBand(title: string, subtitle: string, settingsPath?: string) {
  return (_ctx: PanelRenderContext) => ({
    title,
    subtitle,
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
    pageBand: defaultBand("Myra", "Opening your default channel"),
    pageSpecific: (ctx) => (
      <LiveActivityBand path={ctx.path} onNavigate={ctx.onNavigate} />
    ),
  });

  registerPanelContribution({
    id: "channels",
    match: (path) => isChannelPath(path),
    pageBand: (ctx) => {
      const channelId = channelIdFromPath(ctx.path);
      return {
        // Header title must stay a string for SidebarPanelHeader (react-ui pin).
        title: "Channels",
        subtitle:
          channelId === null
            ? "Open a conversation in the canvas"
            : "Channel open in the canvas",
        actions: [
          {
            id: "new-channel",
            label: "New channel",
            onSelect: () => {
              window.dispatchEvent(
                new CustomEvent("workbench:chat:new-channel"),
              );
              if (!isChannelPath(ctx.path)) ctx.onNavigate(channelPath(null));
            },
          },
        ],
        stats: (
          <ChannelPageTitle
            channelId={channelId}
            fallback="No channel selected"
          />
        ),
      };
    },
    pageSpecific: (ctx) => (
      <ChannelsBand path={ctx.path} onOpenInCanvas={ctx.onOpenInCanvas} />
    ),
  });

  registerPanelContribution({
    id: "inbox",
    match: (path) => pathMatches("/inbox", path),
    pageBand: defaultBand(
      "Inbox",
      "Approvals and notifications for this bench",
    ),
    pageSpecific: (ctx) => (
      <InboxFiltersBand path={ctx.path} onNavigate={ctx.onNavigate} />
    ),
  });

  registerPanelContribution({
    id: "agents",
    match: (path) => pathMatches("/agents", path),
    pageBand: (ctx) => ({
      title: "Agents",
      subtitle: "Definitions that run on this bench",
      actions: [
        {
          id: "create-agent",
          label: "Create agent",
          onSelect: () => {
            window.dispatchEvent(new CustomEvent("workbench:agents:create"));
            if (!pathMatches("/agents", ctx.path)) ctx.onNavigate("/agents");
          },
        },
      ],
    }),
    pageSpecific: (ctx) => (
      <LiveActivityBand path={ctx.path} onNavigate={ctx.onNavigate} />
    ),
  });

  registerPanelContribution({
    id: "routines",
    match: (path) => pathMatches("/routines", path),
    pageBand: (ctx) => ({
      title: "Routines",
      subtitle: "Scheduled and on-demand workflows",
      actions: [
        {
          id: "create-routine",
          label: "Create routine",
          onSelect: () => {
            window.dispatchEvent(new CustomEvent("workbench:routines:create"));
            if (!pathMatches("/routines", ctx.path))
              ctx.onNavigate("/routines");
          },
        },
      ],
    }),
    pageSpecific: (ctx) => <RoutinesFeedBand onNavigate={ctx.onNavigate} />,
  });

  registerPanelContribution({
    id: "library",
    match: (path) => pathMatches("/library", path),
    pageBand: defaultBand("Library", "Artifacts this bench has produced"),
    pageSpecific: (ctx) => (
      <div className="panel-stack" aria-label="Library kinds">
        {(
          [
            ["all", "All"],
            ["document", "Docs"],
            ["sheet", "Sheets"],
            ["pdf", "PDFs"],
            ["routine", "Routines"],
          ] as const
        ).map(([id, label]) => (
          <SidebarItemRow
            key={id}
            name={label}
            selected={
              id === "all"
                ? ctx.path === "/library"
                : ctx.path === `/library/${id}`
            }
            onSelect={() =>
              ctx.onNavigate(id === "all" ? "/library" : `/library/${id}`)
            }
          />
        ))}
      </div>
    ),
  });

  registerPanelContribution({
    id: "skills",
    match: (path) => pathMatches("/skills", path),
    pageBand: defaultBand(
      "Skills",
      "Packaged capabilities an agent definition can pick up",
    ),
    pageSpecific: () => (
      <div className="panel-stack" aria-label="Skills filters">
        <SidebarItemRow name="All skills" selected meta="session" />
        <SidebarItemRow name="Shared" />
        <SidebarItemRow name="Private" />
      </div>
    ),
  });

  registerPanelContribution({
    id: "insights",
    match: (path) => pathMatches("/insights", path),
    pageBand: defaultBand("Insights", "Usage and audit trail for this bench"),
  });

  registerPanelContribution({
    id: "settings",
    match: (path) => pathMatches("/settings", path),
    pageBand: defaultBand("Settings", "Bench, members, and preferences"),
  });

  registerPanelContribution({
    id: "benches",
    match: (path) => pathMatches("/benches", path),
    pageBand: defaultBand("Benches", "Every workbench you can access"),
  });
}
