// The chat surface's own sidebar: two sections (pinned Channels, ordinary
// Chats) plus the "new channel" affordance. Deliberately not the app's
// global nav rail (`SidebarItem` there is for the six top-level routes) —
// this is a second, page-local list nested inside the Chat route's content
// area, styled to match via the same design tokens.
//
// Each row also carries a hover-revealed ellipsis menu (Discord/LibreChat's
// row-level pattern) for the actions that don't warrant opening the full
// channel settings panel: renaming inline and toggling pinned. "Channel
// settings" in that same menu is the one item that does open the panel,
// matching `chat-workspace.tsx`'s header affordance for the same dialog.

import { isAgentAddress } from "@corbits/chat/mentions";
import {
  Badge,
  Button,
  EmptyState,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from "@corbits/react-ui";
import { MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";
import type { KeyboardEvent } from "react";

import type { Channel } from "./api";
import { isKnownChannelKind } from "./api";
import { CHAT_STRINGS } from "./strings";
import { AgentBadge } from "./timeline";

/**
 * The row menu's item labels for a given channel, pure so its pinned-state
 * wording ("Pin" vs "Unpin") is testable without opening the (portaled,
 * Radix-controlled) menu itself.
 */
export function rowMenuLabels(
  channel: Pick<Channel, "pinned">,
): readonly [rename: string, pin: string, settings: string] {
  return [
    CHAT_STRINGS.rowMenuRename,
    channel.pinned ? CHAT_STRINGS.rowMenuUnpin : CHAT_STRINGS.rowMenuPin,
    CHAT_STRINGS.rowMenuSettings,
  ];
}

/**
 * What a rename submission should send: `undefined` for input that resolves
 * to nothing worth saving (blank, or unchanged from the channel's current
 * title) — the caller's cue to treat the rename as a no-op cancel rather
 * than an empty-name PATCH.
 */
export function renamePayload(
  input: string,
  currentTitle: string,
): string | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed === currentTitle) return undefined;
  return trimmed;
}

function ChannelRow({
  channel,
  active,
  onSelect,
  onRename,
  onTogglePin,
  onOpenSettings,
}: {
  readonly channel: Channel;
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly onRename: (channelId: string, name: string) => void;
  readonly onTogglePin: (channel: Channel) => void;
  readonly onOpenSettings: (channel: Channel) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(channel.title);
  const [renameLabel, pinLabel, settingsLabel] = rowMenuLabels(channel);

  // A single-agent chat badges its fixed agent; a channel of the pinned
  // kind never does. A kind this UI doesn't otherwise recognize renders
  // through the same neutral path as a channel.
  const agentParticipant =
    isKnownChannelKind(channel.kind) && channel.kind === "chat"
      ? channel.participants.find((participant) =>
          isAgentAddress(participant.address),
        )
      : undefined;

  function startRename() {
    setRenameValue(channel.title);
    setRenaming(true);
  }

  function commitRename() {
    const payload = renamePayload(renameValue, channel.title);
    setRenaming(false);
    if (payload !== undefined) onRename(channel.id, payload);
  }

  function handleRenameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setRenaming(false);
    }
  }

  if (renaming) {
    return (
      <input
        className="chat-sidebar-item chat-sidebar-item-rename"
        autoFocus
        value={renameValue}
        aria-label={CHAT_STRINGS.rowMenuRename}
        onChange={(event) => setRenameValue(event.target.value)}
        onKeyDown={handleRenameKeyDown}
        onBlur={commitRename}
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
        <span>{channel.title || CHAT_STRINGS.unnamedChannel}</span>
        {agentParticipant !== undefined ? <AgentBadge /> : null}
        {channel.legacy === true ? (
          <Badge tone="neutral">{CHAT_STRINGS.legacyBadgeLabel}</Badge>
        ) : null}
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
          <MenuItem onSelect={() => onTogglePin(channel)}>{pinLabel}</MenuItem>
          <MenuItem onSelect={() => onOpenSettings(channel)}>
            {settingsLabel}
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}

export function ChatSidebar({
  channels,
  chats,
  activeChannelId,
  onSelect,
  onNewChannel,
  onRename,
  onTogglePin,
  onOpenSettings,
}: {
  readonly channels: readonly Channel[];
  readonly chats: readonly Channel[];
  readonly activeChannelId: string | null;
  readonly onSelect: (channel: Channel) => void;
  readonly onNewChannel: () => void;
  readonly onRename: (channelId: string, name: string) => void;
  readonly onTogglePin: (channel: Channel) => void;
  readonly onOpenSettings: (channel: Channel) => void;
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
                  onRename={onRename}
                  onTogglePin={onTogglePin}
                  onOpenSettings={onOpenSettings}
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
                  onRename={onRename}
                  onTogglePin={onTogglePin}
                  onOpenSettings={onOpenSettings}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
