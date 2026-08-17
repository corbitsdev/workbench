// Every user-facing word the conversation surface prints, in one place.
// The package underneath calls everything a "channel" — a `kind` string of
// "channel" or "chat" — but the app decides what a human reads: a
// "workbench" is the product word for a conversation with an agent (each
// one its own tenancy). Nothing in the chat/* components inlines its own
// copy; it imports from here. There is no in-package new-workbench dialog
// any more (CL-6138): the one creation verb mints and navigates directly —
// see `apps/web/src/instant-agent-create.ts`.

export const CHAT_STRINGS = {
  channelsSectionLabel: "Pinned",
  chatsSectionLabel: "Workbenches",
  noChannelsTitle: "No workbenches yet",
  noChannelsDescription: "Create one to get started.",
  noChatSelectedTitle: "Select a conversation",
  noChatSelectedDescription:
    "Choose a workbench from the sidebar, or create a new one.",
  couldNotLoadChannels: "workbenches",
  couldNotLoadMessages: "messages",
  channelNotFoundTitle: "This workbench isn't here anymore",
  channelNotFoundDescription:
    "It may have been deleted, or the link is out of date.",
  channelNotFoundAction: "Back to workbenches",
  composerPlaceholder:
    "Send a message… use @ to mention an agent, / for commands",
  composerPlaceholderChat: (name: string) => `Message ${name}… / for commands`,
  composerSend: "Send",
  composerSending: "Sending…",
  composerKeyboardHint: "Enter to send",
  composerAttach: "Attach files",
  composerAttachmentsLabel: "Selected attachments",
  composerRemoveAttachment: (name: string) => `Remove ${name}`,
  composerPreparing: "Preparing attachments…",
  composerAttachmentCountError: (max: number) =>
    `You can attach at most ${max} files.`,
  composerAttachmentPerFileError: (name: string, maxMiB: number) =>
    `"${name}" is too large (max ${maxMiB} MB per file).`,
  composerAttachmentTotalError: (maxMiB: number) =>
    `Those files total more than ${maxMiB} MB.`,
  composerAttachmentReadError: "Couldn't read one of those files — try again.",
  composerDictate: "Dictate",
  composerDictateStop: "Stop dictating",
  filePartLabel: "Attachment",
  emptyTimelineTitle: "No messages yet",
  emptyTimelineDescription: "Say something to get the conversation going.",
  mentionEmpty: "No matches",
  mentionBringInGroupLabel: "Bring in…",
  mentionForbidden: "You can't add people to this workbench",
  composerSlashEmpty: "No matching commands",
  composerSummarizeNoAgentError:
    "No agent in this conversation to summarize for — invite one first.",
  composerHelpTitle: "Slash commands",
  composerHelpNote: "Not sent as a message",
  composerHelpClose: "Close",
  runRoutineUnavailable: "Open Routines to run one",
  unnamedChannel: "Untitled conversation",
  unnamedRun: "Untitled agent",
  fallbackPartLabel: (kind: string) => `[${kind}]`,
  senderYou: "You",
  senderFallbackMember: "Member",
  agentBadgeLabel: "Agent",
  legacyBadgeLabel: "Legacy",
  eventAgentJoined: (displayName: string) => `${displayName} joined`,
  eventAgentJoinedUnknown: "An agent joined",
  eventMembershipChanged: "Membership updated",
  eventSettingsChanged: "Settings updated",
  eventChannelRenamed: (from: string, to: string): string =>
    `Renamed "${from}" to "${to}"`,
  eventChannelRenamedTo: (to: string): string => `Renamed to "${to}"`,
  eventBlockResponsePoll: "A vote was recorded",
  eventBlockResponseForm: "A form was submitted",
  eventGeneric: (event: string) => event.replace(/[.\-_]+/g, " "),
  inviteAgentAction: "Invite agent",
  routinesAction: "Routines",
  insightsAction: "Insights",
  channelMembersLabel: "Members",
  teamStackOverflow: (count: number) =>
    `${count} more ${count === 1 ? "member" : "members"}`,
  threadsMenuCount: (count: number) =>
    `${count} ${count === 1 ? "thread" : "threads"}`,
  inviteAgentDialogTitle: "Invite an agent",
  inviteAgentDialogDescription:
    "Launch one of your workbench's agents into this conversation.",
  inviteAgentEmptyTitle: "No agents to invite",
  inviteAgentEmptyDescription:
    "Add an agent to this workbench before inviting it here.",
  inviteAgentLoadError: "Couldn't load invitable agents",
  inviteAgentInviting: "Inviting…",
  inviteAgentInviteError: "Couldn't invite that agent — try again.",
  inviteAgentConflictError: "This workbench already has its agent.",
  forkThreadAction: "Fork",
  forkThreadError: "Couldn't fork that message into a thread — try again.",
  replyInThreadAction: "Reply in thread",
  messageActionsMenuLabel: "Message actions",
  copyTextAction: "Copy text",
  copyTextCopiedToast: "Copied",
  copyTextError: "Couldn't copy — try again.",
  forkThreadOriginBanner: "Forked from a message in",
  channelCreatedToast: (title: string) => `Created · ${title}`,
  channelRenamedToast: (title: string) => `Renamed to ${title}`,
  channelPinnedToast: (pinned: boolean, title: string) =>
    pinned ? `Pinned ${title}` : `Unpinned ${title}`,
  channelPinToggleError: (pinned: boolean) =>
    pinned
      ? "Couldn't pin that workbench — try again."
      : "Couldn't unpin that workbench — try again.",
  reactionChipLabel: (emoji: string, count: number) =>
    `React with ${emoji} (${count})`,
  reactionAddAction: "Add reaction",
  reactionPickerLabel: "Choose a reaction",
  reactionPickerOptionLabel: (emoji: string) => `React with ${emoji}`,
  reactionToggleError: "Couldn't update that reaction — try again.",
  pinMessageAction: "Pin message",
  unpinMessageAction: "Unpin message",
  pinMessageError: "Couldn't pin that message — try again.",
  unpinMessageError: "Couldn't unpin that message — try again.",
  pinnedStripLabel: "Pinned messages",
  pinnedStripEmptyPreview: "Pinned message",
  pinnedStripJumpAction: (preview: string) => `Jump to: ${preview}`,
  pendingSendLabel: "Sending…",
  pendingSendFailedLabel: "Not sent",
  pendingSendRetryAction: "Retry",
  pendingSendDiscardAction: "Discard",
  fallbackPartUnsupported: "Unsupported content",
  blockUnsupportedTitle: "Unsupported block",
  blockUnsupportedBody: (type: string) =>
    `This "${type}" block can't be shown here yet.`,
  blockApproveAction: "Approve",
  blockDenyAction: "Deny",
  blockRiskLabel: (risk: "low" | "medium" | "high") =>
    risk === "low"
      ? "Low risk"
      : risk === "medium"
        ? "Medium risk"
        : "High risk",
  blockFormSubmit: "Submit",
  blockApproveStatusLoading: "Checking status…",
  blockApproveStatusApproved: "Approved",
  blockApproveStatusRejected: "Denied",
  blockApproveStatusTimeout: "Timed out",
  blockApproveStatusExpired: "Expired",
  blockApproveStatusNotFound: "This approval could not be found.",
  blockApproveStatusLoadError: "Couldn't load this approval's status.",
  blockApproveSpectatorNote:
    "Only an approver on this workbench can act on this.",
  blockApproveUndeterminedNote:
    "Your access to act on this could not be confirmed yet — try Approve or Deny to find out.",
  blockApproveApproving: "Approving…",
  blockApproveRejecting: "Denying…",
  blockApproveActionForbidden: "You do not have permission to act on this.",
  blockApproveActionError: "Couldn't reach the approval — try again.",
  blockApprovePlatformRequestedBy: (agentName: string) =>
    `Requested by ${agentName}`,
  blockApproveAgentNoteLabel: "Agent's note",
  blockApproveConflictNote:
    "Someone else already resolved this while you were deciding.",
  blockPollVoteCount: (count: number) =>
    count === 1 ? "1 vote" : `${count} votes`,
  blockPollYourVote: "Your vote",
  blockPollChangeVote: "Change vote",
  blockPollVoteError: "Couldn't record your vote — try again.",
  blockFormSubmitting: "Submitting…",
  blockFormSubmitted: "Submitted",
  blockFormEdit: "Edit response",
  blockFormSubmitError: "Couldn't submit — try again.",
  blockFormFieldRequired: "This field is required.",
  blockQuestionFreeTextLabel: "Type your own answer",
  blockQuestionFreeTextPlaceholder: "Type your own answer…",
  blockQuestionSubmit: "Send",
  blockQuestionSubmitting: "Sending…",
  blockQuestionAnswerError: "Couldn't send your answer — try again.",
  blockQuestionAnsweredLabel: "Your answer",
  optionLetter: (index: number) => String.fromCharCode(65 + index),
  dayDividerToday: "Today",
  dayDividerYesterday: "Yesterday",
  typingIndicator: (label: string) => `${label} is typing`,
  agentsTyping: (names: readonly string[]) => {
    if (names.length === 0) return "";
    if (names.length === 1) return `${names[0]} is typing…`;
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
    const others = names.length - 2;
    return `${names[0]}, ${names[1]} and ${others} ${others === 1 ? "other" : "others"} are typing…`;
  },
  rowMenuLabel: "Conversation actions",
  rowMenuRename: "Rename",
  rowMenuPin: "Pin",
  rowMenuUnpin: "Unpin",
  rowMenuSettings: "Settings",
  renameCancel: "Escape to cancel",
  channelSettingsAction: "Settings",
  channelSettingsBreadcrumbLabel: "Settings breadcrumb",
  channelSettingsBreadcrumbCurrent: "Workbench Settings",
  channelSettingsNavLabel: "Settings sections",
  channelSettingsGroupShared: "Shared",
  channelSettingsGroupPersonal: "Personal",
  channelSettingsSectionGeneral: "General",
  channelSettingsSectionMembers: "Members",
  channelSettingsSectionAgents: "Agents",
  channelSettingsSectionAssistant: "Myra",
  channelSettingsSectionKeysPlugins: "Keys & plugins",
  channelSettingsSectionInference: "Inference",
  channelSettingsSectionCapacity: "Capacity",
  channelSettingsSectionNotifications: "Notifications",
  channelSettingsSectionDanger: "Danger zone",
  channelSettingsNameLabel: "Name",
  channelSettingsPurposeLabel: "Purpose",
  channelSettingsPurposePlaceholder: "What is this for?",
  channelSettingsPinnedLabel: "Pinned",
  channelSettingsPinnedDescription:
    "Pinned conversations stay at the top for the whole workbench.",
  channelSettingsContextWindowLabel: "Conversation memory",
  channelSettingsContextWindowDescription:
    "How many prior messages a mentioned agent sees as context.",
  channelSettingsUseBenchDefault: (benchDefault: number) =>
    `Use workbench default (${benchDefault})`,
  channelSettingsUseOverride: "Set a custom value for this conversation",
  channelSettingsContextWindowDisabled:
    "Disabled — mentioned agents see no history",
  channelSettingsContextWindowCustom: (count: number) =>
    `Last ${count} messages`,
  channelSettingsDeliveryTitle: "Delivery thread",
  channelSettingsDeliveryBody:
    "Routine and agent delivery always lands in a dedicated delivery thread — never the main timeline — so broadcast stays readable.",
  channelSettingsParticipantsLabel: "Participants",
  channelSettingsPeopleLabel: "People",
  channelSettingsAgentsLabel: "Agents",
  channelSettingsNoPeople: "No people here yet.",
  channelSettingsNoAgents: "No agents invited yet.",
  channelSettingsRemoveAction: "Remove",
  channelSettingsRemoveConfirmLabel: "Click again to remove",
  channelSettingsRemoveConsequence: "They lose access to this workbench.",
  channelSettingsRemoveSelfHint: "You can't remove yourself.",
  channelSettingsRemoveError: "Couldn't remove them — try again.",
  channelSettingsRemoving: "Removing…",
  channelSettingsAutonomyTitle: "Autonomy",
  channelSettingsAutonomyBody:
    "Per-conversation autonomy overrides are not stored yet. Agents inherit the workbench default until that control lands.",
  channelSettingsAssistantNameLabel: "Name",
  channelSettingsAssistantInstructionsLabel: "Instructions",
  channelSettingsAssistantInstructionsHint:
    "How this agent should act and what it knows to do. Applies from this agent's next reply in this conversation; other conversations with the same agent pick it up the next time their agent wakes.",
  channelSettingsAssistantLoadError: "Couldn't load this agent's instructions",
  channelSettingsAssistantSaveError: "Couldn't save these changes — try again.",
  channelSettingsAssistantSavedToast: "Instructions saved",
  channelSettingsAssistantSave: "Save",
  channelSettingsAssistantSaving: "Saving…",
  channelSettingsAssistantCancel: "Cancel",
  channelSettingsAssistantNoAgents:
    "No agents to configure in this conversation.",
  channelSettingsAssistantCapabilitiesTitle: "Capabilities",
  channelSettingsAssistantCapabilitiesHint:
    "What this agent can use. Add a tool, skill, or model from what's available in this workbench.",
  channelSettingsAssistantNoCapabilities: "No tools, skills, or model set yet.",
  channelSettingsAssistantModelLabel: "Model",
  channelSettingsAssistantAddCapabilityLabel: "Add a capability",
  channelSettingsAssistantAddCapabilityKindTool: "Tool",
  channelSettingsAssistantAddCapabilityKindSkill: "Skill",
  channelSettingsAssistantAddCapabilityKindModel: "Model",
  channelSettingsAssistantAddCapabilityButton: "Add",
  channelSettingsAssistantAddCapabilityAdding: "Adding…",
  channelSettingsAssistantAddCapabilityError:
    "Couldn't add that — it may no longer be available.",
  channelSettingsAssistantCapabilityInventoryError:
    "Couldn't load what's available to add.",
  channelSettingsAssistantHistoryTitle: "History",
  channelSettingsAssistantHistoryHint:
    "Every change to this agent's instructions and capabilities, oldest actions first.",
  channelSettingsAssistantHistoryLoadError:
    "Couldn't load this agent's history",
  channelSettingsAssistantHistoryEmpty: "No history yet.",
  channelSettingsAssistantHistoryCurrent: "Current",
  channelSettingsAssistantHistoryRestore: "Restore",
  channelSettingsAssistantHistoryRestoring: "Restoring…",
  channelSettingsAssistantHistoryRestoreError:
    "Couldn't restore that version — try again.",
  channelSettingsNotificationsLabel: "Notifications",
  channelSettingsNotifyAll: "All messages",
  channelSettingsNotifyMentions: "Mentions only",
  channelSettingsNotifyMute: "Mute",
  channelSettingsNotificationsHint:
    "This choice is yours alone — it doesn't change notifications for anyone else.",
  channelSettingsNotificationsSaveError:
    "Couldn't save your notification setting — try again.",
  channelSettingsCapacityDescription:
    "Run this workbench's agents on their own machine.",
  channelSettingsCapacityLabel: "Run on a dedicated machine",
  channelSettingsCapacityHint:
    "This workbench's agents won't share a machine with any other workbench, so heavy work here never slows the others down.",
  channelSettingsCapacityUnavailableHint:
    "Not available on this server yet — ask your operator to enable isolated capacity.",
  channelSettingsCapacitySaveError: (enabling: boolean) =>
    enabling
      ? "Couldn't turn on dedicated capacity — try again."
      : "Couldn't turn off dedicated capacity — try again.",
  channelSettingsArchiveTitle: "Archive workbench",
  channelSettingsArchiveBody:
    "Archiving is not available yet. Closing this workbench would hide it from the sidebar without deleting history once the action lands.",
  channelSettingsLoadError: "this conversation's settings",
  channelSettingsSaveError:
    "Couldn't save this conversation's settings — try again.",
  channelSettingsSavedToast: "Settings saved",
  channelSettingsSave: "Save",
  channelSettingsSaving: "Saving…",
  channelSettingsNoParticipants: "No participants yet.",
  profileOpenAction: "Open profile",
  fixConnectionAction: "Fix this connection",
  profileMessageAction: "Message",
  profileViewSettingsAction: "View settings",
  profileSharedChannels: "Shared workbenches",
  profilePinnedSkills: "Pinned skills",
  profileAgentStatus: "Agent",
  profileMemberStatus: "Member",
} as const;
