// The chat surface's own sidebar: two sections (pinned Channels, ordinary
// Chats) plus the "new channel" affordance. Deliberately not the app's
// global nav rail (`SidebarItem` there is for the six top-level routes) —
// this is a second, page-local list nested inside the Chat route's content
// area, styled to match via the same design tokens.

import { Button, EmptyState } from "@corbits/react-ui";
import { Plus } from "lucide-react";

import type { Channel } from "./api";
import { CHAT_STRINGS } from "./strings";

function ChannelRow({
  channel,
  active,
  onSelect,
}: {
  readonly channel: Channel;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="chat-sidebar-item"
      aria-current={active ? "true" : undefined}
      data-active={active}
      onClick={onSelect}
    >
      {channel.title || CHAT_STRINGS.unnamedChannel}
    </button>
  );
}

export function ChatSidebar({
  channels,
  chats,
  activeChannelId,
  onSelect,
  onNewChannel,
}: {
  readonly channels: readonly Channel[];
  readonly chats: readonly Channel[];
  readonly activeChannelId: string | null;
  readonly onSelect: (channel: Channel) => void;
  readonly onNewChannel: () => void;
}) {
  const isEmpty = channels.length === 0 && chats.length === 0;

  return (
    <div className="chat-sidebar">
      <div className="chat-sidebar-header">
        <Button variant="outline" size="sm" onClick={onNewChannel}>
          <Plus />
          {CHAT_STRINGS.newChannelAction}
        </Button>
      </div>
      {isEmpty ? (
        <EmptyState
          title={CHAT_STRINGS.noChannelsTitle}
          description={CHAT_STRINGS.noChannelsDescription}
          action={
            <Button variant="primary" size="sm" onClick={onNewChannel}>
              {CHAT_STRINGS.newChannelAction}
            </Button>
          }
        />
      ) : (
        <>
          {channels.length > 0 && (
            <div className="chat-sidebar-section">
              <div className="chat-sidebar-section-label">
                {CHAT_STRINGS.channelsSectionLabel}
              </div>
              {channels.map((channel) => (
                <ChannelRow
                  key={channel.id}
                  channel={channel}
                  active={channel.id === activeChannelId}
                  onSelect={() => onSelect(channel)}
                />
              ))}
            </div>
          )}
          {chats.length > 0 && (
            <div className="chat-sidebar-section">
              <div className="chat-sidebar-section-label">
                {CHAT_STRINGS.chatsSectionLabel}
              </div>
              {chats.map((channel) => (
                <ChannelRow
                  key={channel.id}
                  channel={channel}
                  active={channel.id === activeChannelId}
                  onSelect={() => onSelect(channel)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
