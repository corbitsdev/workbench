// Registers each page's contextual-panel contribution. Imported once from
// the shell so matchers are on the registry before first render.

import { EmptyState, SidebarItemRow, Skeleton } from "@corbits/react-ui";
import { Hash, MessageSquare, Workflow, Bell } from "lucide-react";

import { useBench } from "../bench-context";
import { channelIdFromPath, channelPath, isChannelPath } from "../channel-path";
import { useBenchActivity } from "./bench-activity";
import {
  registerPanelContribution,
  type PanelRenderContext,
} from "./panel-contribution";
import type { RoutineActivityItem } from "./routine-activity";

function pathMatches(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function ChannelsBand({
  path,
  onNavigate,
  onOpenInCanvas,
}: {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
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

  const channels = activity.channels;
  const chats = activity.chats;
  if (channels.length === 0 && chats.length === 0) {
    return (
      <EmptyState
        icon={<MessageSquare />}
        title="No channels yet"
        description="Create a channel to start a conversation."
      />
    );
  }

  return (
    <div className="panel-stack">
      {channels.length > 0 ? (
        <div className="panel-stack-group">
          <p className="panel-band-subheading">Channels</p>
          {channels.map((channel) => (
            <SidebarItemRow
              key={channel.id}
              name={channel.title || "Untitled channel"}
              selected={channel.id === activeId}
              onSelect={() => onNavigate(`${channelPath(channel.id)}`)}
            />
          ))}
        </div>
      ) : null}
      {chats.length > 0 ? (
        <div className="panel-stack-group">
          <p className="panel-band-subheading">Chats</p>
          {chats.map((channel) => (
            <SidebarItemRow
              key={channel.id}
              name={channel.title || "Untitled chat"}
              selected={channel.id === activeId}
              onSelect={() => onNavigate(`${channelPath(channel.id)}`)}
            />
          ))}
        </div>
      ) : null}
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
          onSelect={() => onNavigate("/routines")}
        />
      ))}
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
            <SidebarItemRow
              key={channel.id}
              name={channel.title || "Untitled channel"}
              selected={channel.id === activeId}
              onSelect={() => onNavigate(`${channelPath(channel.id)}`)}
            />
          ))}
        </div>
      ) : null}
      {activity.chats.length > 0 ? (
        <div className="panel-stack-group">
          <p className="panel-band-subheading">Chats</p>
          {activity.chats.map((channel) => (
            <SidebarItemRow
              key={channel.id}
              name={channel.title || "Untitled chat"}
              selected={channel.id === activeId}
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
    pageBand: defaultBand("Home", "Your workbench at a glance"),
    pageSpecific: (ctx) => (
      <LiveActivityBand path={ctx.path} onNavigate={ctx.onNavigate} />
    ),
  });

  registerPanelContribution({
    id: "channels",
    match: (path) => isChannelPath(path),
    pageBand: (ctx) => ({
      title: "Channels",
      subtitle: "Open a conversation in the canvas",
      actions: [
        {
          id: "new-channel",
          label: "New channel",
          onSelect: () => {
            window.dispatchEvent(new CustomEvent("workbench:chat:new-channel"));
            if (!isChannelPath(ctx.path)) ctx.onNavigate(channelPath(null));
          },
        },
      ],
    }),
    pageSpecific: (ctx) => (
      <ChannelsBand path={ctx.path} onNavigate={ctx.onNavigate} onOpenInCanvas={ctx.onOpenInCanvas} />
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
  });

  registerPanelContribution({
    id: "skills",
    match: (path) => pathMatches("/skills", path),
    pageBand: defaultBand(
      "Skills",
      "Packaged capabilities an agent definition can pick up",
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
