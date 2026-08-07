// Every user-facing word the chat surface prints, in one place. The package
// underneath calls everything a "channel" — a `kind` string of "channel" or
// "chat" — but the app decides what a human reads: "Channels" for the pinned,
// broadcast-style kind and "Chats" for everything else. Nothing in the chat/*
// components inlines its own copy; it imports from here.

export const CHAT_STRINGS = {
  channelsSectionLabel: "Channels",
  chatsSectionLabel: "Chats",
  newChannelAction: "New channel",
  newChannelDialogTitle: "New channel",
  newChannelDialogDescription:
    "Give it a name and choose whether it is a pinned channel or an ordinary chat.",
  newChannelNameLabel: "Name",
  newChannelNamePlaceholder: "e.g. Launch planning",
  newChannelKindLabel: "Type",
  newChannelKindChannel: "Channel — pinned, for the whole bench",
  newChannelKindChat: "Chat — an ordinary conversation",
  newChannelSubmit: "Create",
  newChannelCancel: "Cancel",
  noChannelsTitle: "No channels yet",
  noChannelsDescription:
    "Create a channel to start a conversation your agents and teammates can see.",
  noChatSelectedTitle: "Select a conversation",
  noChatSelectedDescription:
    "Choose a channel or chat from the sidebar, or start a new one.",
  couldNotLoadChannels: "channels",
  couldNotLoadMessages: "messages",
  composerPlaceholder: "Message this channel… use @ to mention an agent",
  composerSend: "Send",
  emptyTimelineTitle: "No messages yet",
  emptyTimelineDescription: "Say something to get the conversation going.",
  reconnectingMessage: "Reconnecting to the channel…",
  mentionEmpty: "No matching agents",
  unnamedChannel: "Untitled",
  fallbackPartLabel: (kind: string) => `[${kind}]`,
  inviteAgentAction: "Invite agent",
  inviteAgentDialogTitle: "Invite an agent",
  inviteAgentDialogDescription:
    "Launch one of your bench's deployed agents into this channel.",
  inviteAgentEmptyTitle: "No agents to invite",
  inviteAgentEmptyDescription:
    "Deploy a workflow definition on this bench before inviting it here.",
  inviteAgentLoadError: "Couldn't load invitable agents",
  inviteAgentInviting: "Inviting…",
} as const;
