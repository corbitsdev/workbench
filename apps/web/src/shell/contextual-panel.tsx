// Column 2: the bench-scoped live activity rail. Answers "what is
// happening in this bench right now" — channels, chats, and running
// routines for the currently selected bench, plus a slot for notifications
// once the hub has something to send. Nothing here is a page list: it
// refetches on bench changes, never on route changes, so items can persist
// or travel across page navigation exactly as live activity should.

import {
  EmptyState,
  Skeleton,
  SidebarItemRow,
  SidebarPanel,
  SidebarPanelBody,
  SidebarPanelHeader,
  SidebarPanelSection,
  useSidebarPanel,
} from "@corbits/react-ui";
import type { Channel } from "@corbits/chat-ui";
import { Bell, Hash, MessageSquare, Workflow } from "lucide-react";

import { useBench } from "../bench-context";
import { useBenchActivity } from "./bench-activity";
import type { RoutineActivityItem } from "./routine-activity";

const CHANNELS_SECTION_ID = "channels";
const CHATS_SECTION_ID = "chats";
const ROUTINES_SECTION_ID = "routines";
const NOTIFICATIONS_SECTION_ID = "notifications";
const CHAT_PATH_PREFIX = "/chat";

function activeChatChannelId(path: string): string | null {
  if (!path.startsWith(`${CHAT_PATH_PREFIX}/`)) return null;
  const rest = path.slice(CHAT_PATH_PREFIX.length + 1);
  return rest === "" ? null : decodeURIComponent(rest);
}

function ChannelRow({
  channel,
  active,
  onNavigate,
}: {
  readonly channel: Channel;
  readonly active: boolean;
  readonly onNavigate: (to: string) => void;
}) {
  return (
    <SidebarItemRow
      name={channel.title || "Untitled channel"}
      selected={active}
      onSelect={() =>
        onNavigate(`${CHAT_PATH_PREFIX}/${encodeURIComponent(channel.id)}`)
      }
    />
  );
}

function RoutineRow({ routine }: { readonly routine: RoutineActivityItem }) {
  return <SidebarItemRow name={routine.name} meta={routine.status} />;
}

export function ContextualPanel({
  path,
  onNavigate,
}: {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
}) {
  const { selectedTenantId } = useBench();
  const activity = useBenchActivity(selectedTenantId);
  const activeChannelId = activeChatChannelId(path);
  const {
    isSectionCollapsed,
    toggleSection,
    panelKey,
    panelTransitionClassName,
  } = useSidebarPanel({ activePageId: selectedTenantId ?? "" });

  return (
    <SidebarPanel
      data-testid="shell-contextual-panel"
      style={{ width: "var(--shell-contextual-width)" }}
    >
      <SidebarPanelHeader title="Activity" />
      <SidebarPanelBody key={panelKey} className={panelTransitionClassName}>
        {activity.kind === "loading" && (
          <Skeleton className="shell-activity-skeleton" />
        )}
        {activity.kind === "empty" && (
          <EmptyState
            icon={<Hash />}
            title="No bench selected"
            description="Choose a bench from the rail to see its channels, chats, and running routines."
          />
        )}
        {activity.kind === "error" && (
          <EmptyState
            icon={<Hash />}
            title="Couldn't load bench activity"
            description={activity.message}
          />
        )}
        {activity.kind === "ready" && (
          <>
            <SidebarPanelSection
              label="Channels"
              collapsed={isSectionCollapsed(CHANNELS_SECTION_ID)}
              onToggleCollapse={() => toggleSection(CHANNELS_SECTION_ID)}
            >
              {activity.channels.length === 0 ? (
                <EmptyState
                  icon={<Hash />}
                  title="No channels yet"
                  description="Channels created in this bench appear here."
                />
              ) : (
                activity.channels.map((channel) => (
                  <ChannelRow
                    key={channel.id}
                    channel={channel}
                    active={channel.id === activeChannelId}
                    onNavigate={onNavigate}
                  />
                ))
              )}
            </SidebarPanelSection>
            <SidebarPanelSection
              label="Chats"
              collapsed={isSectionCollapsed(CHATS_SECTION_ID)}
              onToggleCollapse={() => toggleSection(CHATS_SECTION_ID)}
            >
              {activity.chats.length === 0 ? (
                <EmptyState
                  icon={<MessageSquare />}
                  title="No chats yet"
                  description="Direct chats with an agent in this bench appear here."
                />
              ) : (
                activity.chats.map((channel) => (
                  <ChannelRow
                    key={channel.id}
                    channel={channel}
                    active={channel.id === activeChannelId}
                    onNavigate={onNavigate}
                  />
                ))
              )}
            </SidebarPanelSection>
            <SidebarPanelSection
              label="Running"
              collapsed={isSectionCollapsed(ROUTINES_SECTION_ID)}
              onToggleCollapse={() => toggleSection(ROUTINES_SECTION_ID)}
            >
              {activity.routines.length === 0 ? (
                <EmptyState
                  icon={<Workflow />}
                  title="Nothing running"
                  description="A routine running in this bench shows up here while it executes."
                />
              ) : (
                activity.routines.map((routine) => (
                  <RoutineRow key={routine.id} routine={routine} />
                ))
              )}
            </SidebarPanelSection>
            <SidebarPanelSection
              label="Notifications"
              collapsed={isSectionCollapsed(NOTIFICATIONS_SECTION_ID)}
              onToggleCollapse={() => toggleSection(NOTIFICATIONS_SECTION_ID)}
            >
              <EmptyState
                icon={<Bell />}
                title="No notifications yet"
                description="This bench has no notification source wired up yet — mentions and mail-backed alerts will land here once it does."
              />
            </SidebarPanelSection>
          </>
        )}
      </SidebarPanelBody>
    </SidebarPanel>
  );
}
