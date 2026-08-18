// Every user-facing word the conversation surface prints, in one place.
// The package underneath calls everything a "workbench" — a `kind` string of
// "workbench" or "chat" — but the app decides what a human reads: a
// "workbench" is the product word for a conversation with an agent (each
// one its own tenancy). Nothing in the chat/* components inlines its own
// copy; it imports from here. There is no in-package new-workbench dialog
// any more (CL-6138): the one creation verb mints and navigates directly —
// see `apps/web/src/instant-agent-create.ts`.

export const CHAT_STRINGS = {
  workbenchesSectionLabel: "Pinned",
  chatsSectionLabel: "Workbenches",
  noWorkbenchesTitle: "No workbenches yet",
  noWorkbenchesDescription: "Create one to get started.",
  noChatSelectedTitle: "Select a conversation",
  noChatSelectedDescription:
    "Choose a workbench from the sidebar, or create a new one.",
  couldNotLoadWorkbenches: "workbenches",
  couldNotLoadMessages: "messages",
  workbenchNotFoundTitle: "This workbench isn't here anymore",
  workbenchNotFoundDescription:
    "It may have been deleted, or the link is out of date.",
  workbenchNotFoundAction: "Back to workbenches",
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
  workbenchLoadingTitle: "Setting up your workbench",
  workbenchLoadingStarting: "Starting the runtime\u2026",
  workbenchLoadingAgentJoined: "Myra is joining\u2026",
  emptyTimelineDescription: "Say something to get the conversation going.",
  mentionEmpty: "No matches",
  mentionAgentsGroupLabel: "Agents",
  mentionPeopleGroupLabel: "People",
  mentionForbidden: "You can't add people to this workbench",
  composerSlashEmpty: "No matching commands",
  composerSummarizeNoAgentError:
    "No agent in this conversation to summarize for — invite one first.",
  composerHelpTitle: "Slash commands",
  composerHelpNote: "Not sent as a message",
  composerHelpClose: "Close",
  runRoutineUnavailable: "Open Routines to run one",
  unnamedWorkbench: "Untitled conversation",
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
  eventWorkbenchRenamed: (from: string, to: string): string =>
    `Renamed "${from}" to "${to}"`,
  eventWorkbenchRenamedTo: (to: string): string => `Renamed to "${to}"`,
  eventBlockResponsePoll: "A vote was recorded",
  eventBlockResponseForm: "A form was submitted",
  eventGeneric: (event: string) => event.replace(/[.\-_]+/g, " "),
  inviteAgentAction: "Invite agent",
  routinesAction: "Routines",
  insightsAction: "Insights",
  workbenchMembersLabel: "Members",
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
  workbenchCreatedToast: (title: string) => `Created · ${title}`,
  workbenchRenamedToast: (title: string) => `Renamed to ${title}`,
  workbenchPinnedToast: (pinned: boolean, title: string) =>
    pinned ? `Pinned ${title}` : `Unpinned ${title}`,
  workbenchPinToggleError: (pinned: boolean) =>
    pinned
      ? "Couldn't pin that workbench — try again."
      : "Couldn't unpin that workbench — try again.",
  agentDmOpenError: (name: string) =>
    `Couldn't open a chat with ${name} — try again.`,
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
  turnActivityThinking: "Thinking…",
  turnActivityRetry: (attempt: number) => `Retrying (attempt ${attempt})…`,
  replyTimedOutNotice: "No reply arrived — the agent may be unavailable.",
  rowMenuLabel: "Conversation actions",
  rowMenuRename: "Rename",
  rowMenuPin: "Pin",
  rowMenuUnpin: "Unpin",
  rowMenuSettings: "Settings",
  renameCancel: "Escape to cancel",
  workbenchSettingsAction: "Settings",
  workbenchSettingsBreadcrumbLabel: "Settings breadcrumb",
  workbenchSettingsBreadcrumbCurrent: "Workbench Settings",
  workbenchSettingsNavLabel: "Settings sections",
  workbenchSettingsGroupShared: "Shared",
  workbenchSettingsGroupPersonal: "Personal",
  workbenchSettingsSectionGeneral: "General",
  workbenchSettingsSectionMembers: "Members",
  workbenchSettingsSectionAgents: "Agents",
  workbenchSettingsSectionPlugins: "Plugins",
  workbenchSettingsSectionCapacity: "Capacity",
  workbenchSettingsSectionNotifications: "Notifications",
  workbenchSettingsSectionDanger: "Danger zone",
  workbenchSettingsNameLabel: "Name",
  workbenchSettingsPurposeLabel: "Purpose",
  workbenchSettingsPurposePlaceholder: "What is this for?",
  workbenchSettingsPinnedLabel: "Pinned",
  workbenchSettingsPinnedDescription:
    "Pinned conversations stay at the top for the whole workbench.",
  workbenchSettingsContextWindowLabel: "Conversation memory",
  workbenchSettingsContextWindowDescription:
    "How many prior messages a mentioned agent sees as context.",
  workbenchSettingsUseBenchDefault: (benchDefault: number) =>
    `Use workbench default (${benchDefault})`,
  workbenchSettingsUseOverride: "Set a custom value for this conversation",
  workbenchSettingsContextWindowDisabled:
    "Disabled — mentioned agents see no history",
  workbenchSettingsContextWindowCustom: (count: number) =>
    `Last ${count} messages`,
  workbenchSettingsDeliveryTitle: "Delivery thread",
  workbenchSettingsDeliveryBody:
    "Routine and agent delivery always lands in a dedicated delivery thread — never the main timeline — so broadcast stays readable.",
  workbenchSettingsParticipantsLabel: "Participants",
  workbenchSettingsPeopleLabel: "People",
  workbenchSettingsAgentsLabel: "Agents",
  workbenchSettingsNoPeople: "No people here yet.",
  workbenchSettingsNoAgents: "No agents invited yet.",
  workbenchSettingsRemoveAction: "Remove",
  workbenchSettingsRemoveConfirmLabel: "Click again to remove",
  workbenchSettingsRemoveConsequence: "They lose access to this workbench.",
  workbenchSettingsRemoveSelfHint: "You can't remove yourself.",
  workbenchSettingsRemoveError: "Couldn't remove them — try again.",
  workbenchSettingsRemoving: "Removing…",
  workbenchSettingsAutonomyTitle: "Autonomy",
  workbenchSettingsAutonomyBody:
    "Per-conversation autonomy overrides are not stored yet. Agents inherit the workbench default until that control lands.",
  workbenchSettingsAgentsBackAction: "All agents",
  workbenchSettingsAgentsInviteHint:
    "Every agent participant in this workbench — click one to edit its instructions, capabilities, and inference model.",
  workbenchSettingsAgentDetailNameLabel: "Name",
  workbenchSettingsAgentDetailInstructionsLabel: "Instructions",
  workbenchSettingsAgentDetailInstructionsHint:
    "How this agent should act and what it knows to do. Applies from this agent's next reply in this conversation; other conversations with the same agent pick it up the next time their agent wakes.",
  workbenchSettingsAgentDetailLoadError:
    "Couldn't load this agent's instructions",
  workbenchSettingsAgentDetailSaveError:
    "Couldn't save these changes — try again.",
  workbenchSettingsAgentDetailSavedToast: "Instructions saved",
  // Scoped rather than a bare "Save" (CL-6215 EMIL #4) — the top-bar Save
  // right above it in the same view saves the conversation's own General
  // fields, a different scope entirely; this one only ever writes this
  // agent's instructions.
  workbenchSettingsAgentDetailSave: "Save instructions",
  workbenchSettingsAgentDetailSaving: "Saving…",
  workbenchSettingsAgentDetailCancel: "Cancel",
  workbenchSettingsAgentDetailNoAgents:
    "No agents to configure in this conversation.",
  workbenchSettingsAgentDetailCapabilitiesTitle: "Capabilities",
  workbenchSettingsAgentDetailCapabilitiesHint:
    "What this agent can use. Add a tool, skill, or model from what's available in this workbench.",
  workbenchSettingsAgentDetailNoCapabilities:
    "No tools, skills, or model set yet.",
  workbenchSettingsAgentDetailModelLabel: "Model",
  workbenchSettingsAgentDetailAddCapabilityLabel: "Add a capability",
  workbenchSettingsAgentDetailAddCapabilityKindTool: "Tool",
  workbenchSettingsAgentDetailAddCapabilityKindSkill: "Skill",
  workbenchSettingsAgentDetailAddCapabilityKindModel: "Provider + model",
  workbenchSettingsAgentDetailAddCapabilityChoiceLabel: "Which one",
  workbenchSettingsAgentDetailAddCapabilityChoicePlaceholder: (
    kind: "toolPackage" | "skill" | "model",
  ) =>
    kind === "toolPackage"
      ? "Choose a tool…"
      : kind === "skill"
        ? "Choose a skill…"
        : "Choose a model…",
  workbenchSettingsAgentDetailAddCapabilityButton: "Add",
  workbenchSettingsAgentDetailAddCapabilityAdding: "Adding…",
  workbenchSettingsAgentDetailAddCapabilityError:
    "Couldn't add that — it may no longer be available.",
  workbenchSettingsAgentDetailCapabilityInventoryError:
    "Couldn't load what's available to add.",
  workbenchSettingsAgentDetailModelOption: (
    canonicalName: string,
    providerName: string,
  ) => `${canonicalName} · ${providerName}`,
  workbenchSettingsAgentDetailNoConnectedModels:
    "No connected providers yet — connect one in Shared Settings.",
  workbenchSettingsAgentDetailHistoryTitle: "History",
  workbenchSettingsAgentDetailHistoryHint:
    "Every change to this agent's instructions and capabilities, oldest actions first.",
  workbenchSettingsAgentDetailHistoryLoadError:
    "Couldn't load this agent's history",
  workbenchSettingsAgentDetailHistoryEmpty: "No history yet.",
  workbenchSettingsAgentDetailHistoryCurrent: "Current",
  workbenchSettingsAgentDetailHistoryRestore: "Restore",
  workbenchSettingsAgentDetailHistoryRestoring: "Restoring…",
  workbenchSettingsAgentDetailHistoryRestoreError:
    "Couldn't restore that version — try again.",
  workbenchSettingsNotificationsLabel: "Notifications",
  workbenchSettingsNotifyAll: "All messages",
  workbenchSettingsNotifyMentions: "Mentions only",
  workbenchSettingsNotifyMute: "Mute",
  workbenchSettingsNotificationsHint:
    "This choice is yours alone — it doesn't change notifications for anyone else.",
  workbenchSettingsNotificationsSaveError:
    "Couldn't save your notification setting — try again.",
  workbenchSettingsCapacityDescription:
    "Run this workbench's agents on their own machine.",
  workbenchSettingsCapacityLabel: "Run on a dedicated machine",
  workbenchSettingsCapacityHint:
    "This workbench's agents won't share a machine with any other workbench, so heavy work here never slows the others down.",
  workbenchSettingsCapacityUnavailableHint:
    "Not available on this server yet — ask your operator to enable isolated capacity.",
  workbenchSettingsCapacitySaveError: (enabling: boolean) =>
    enabling
      ? "Couldn't turn on dedicated capacity — try again."
      : "Couldn't turn off dedicated capacity — try again.",
  workbenchSettingsArchiveTitle: "Archive workbench",
  workbenchSettingsArchiveBody:
    "Archiving is not available yet. Closing this workbench would hide it from the sidebar without deleting history once the action lands.",
  workbenchSettingsLoadError: "this conversation's settings",
  workbenchSettingsSaveError:
    "Couldn't save this conversation's settings — try again.",
  workbenchSettingsSavedToast: "Settings saved",
  workbenchSettingsSave: "Save",
  workbenchSettingsSaving: "Saving…",
  workbenchSettingsNoParticipants: "No participants yet.",
  profileOpenAction: "Open profile",
  fixConnectionAction: "Fix this connection",
  profileMessageAction: "Message",
  profileViewSettingsAction: "View settings",
  profileSharedWorkbenches: "Shared workbenches",
  profilePinnedSkills: "Pinned skills",
  profileAgentStatus: "Agent",
  profileMemberStatus: "Member",
} as const;
