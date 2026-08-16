export { ChatWorkspace } from "./chat-workspace";
export type { TenantResolution, PresenceMember } from "./chat-workspace";

export { ChannelTimeline, messageDomId } from "./timeline";
export type {
  CurrentUser,
  ReactionActions,
  PinActions,
  PendingActions,
  PendingMessageStatus,
  TimelineMessageItem,
} from "./timeline";

export { PinnedStrip } from "./pinned-strip";
export {
  Composer,
  draftAfterSend,
  attachmentsAfterSend,
  partsForSend,
  canSendComposer,
  canSendComposerAction,
  canAttachComposer,
  COMPOSER_ATTACHMENT_LIMITS,
  validateAttachmentPick,
  attachmentValidationMessage,
  attachmentBytesOnComposer,
  base64DecodedByteLength,
  insertTextAtCaret,
  composerSendVisualState,
} from "./composer";
export type {
  ComposerAttachment,
  ComposerSendPayload,
  ComposerAttachmentLimits,
  AttachmentPickCandidate,
  AttachmentValidationError,
  ComposerHandle,
  ComposerSendVisualState,
} from "./composer";
export { FirstRunComposer, textWithAttachments } from "./first-run-composer";
export { renamePayload, rowMenuLabels } from "./sidebar";

export { NewChannelDialog } from "./new-channel-dialog";
export { InviteAgentDialog } from "./invite-agent-dialog";
export { DialogStepper, DialogStepAccordion } from "./dialog-stepper";
export type {
  DialogStepperStep,
  DialogStepStatus,
  DialogStepAccordionStep,
} from "./dialog-stepper";

export { useChannelStream } from "./use-channel-stream";
export type { ChannelStreamState } from "./use-channel-stream";

export {
  activeMentionQuery,
  filterMentionCandidates,
  insertMention,
  mentionCandidatesFromParticipants,
} from "./mentions";
export type { MentionCandidate, MentionQuery } from "./mentions";

export {
  SLASH_COMMANDS,
  activeSlashQuery,
  filterSlashCommands,
} from "./slash-commands";
export type {
  SlashCommandId,
  SlashCommandSpec,
  SlashQuery,
} from "./slash-commands";

export { CHAT_STRINGS } from "./strings";

export { BlockPartView } from "./blocks/registry";
export { BlockCard, RiskBadge } from "./blocks/block-card";
export type {
  ApprovalActions,
  ApprovalLiveStatus,
  ApprovalStatusQuery,
  ApprovalDecisionResult,
  PlatformApprovalDetail,
} from "./blocks/approval-actions";
export type {
  BlockResponseActions,
  BlockResponseQuery,
  BlockResponseSubmitResult,
  BlockResponsePayload,
  PollResponsePayload,
  FormResponsePayload,
} from "./blocks/block-responses";

export {
  TextPart,
  ReasoningPart,
  ToolTracePart,
  BlockPart,
  FilePart,
  EventPart,
  Part,
  ChannelKind,
  isKnownChannelKind,
  MessageSender,
  ChatApiError,
  listChannels,
  listAllChannels,
  channelsQueryKey,
  channelsQueryKeyPrefix,
  CHANNELS_MUTATED_EVENT,
  createChannel,
  listMessages,
  sendMessage,
  fetchChannelBlob,
  listThreads,
  listThreadMessages,
  putReadState,
  listRuns,
  listInvitableDefinitions,
  listTenantInvitableDefinitions,
  inviteAgent,
  channelStreamUrl,
  runDisplayName,
  getChannelSettings,
  patchChannelSettings,
  getBenchChatSettings,
  patchBenchChatSettings,
  getBlockResponses,
  submitPollResponse,
  submitFormResponse,
  REACTION_EMOJI,
  toggleReaction,
  pinMessage,
  unpinMessage,
  listPinnedMessages,
} from "./api";
export type {
  Channel,
  CreateChannelInput,
  ParticipantRecord,
  MessageItem,
  MessagesResponse,
  ChannelThread,
  ThreadMessagesResponse,
  Run,
  InvitableDefinition,
  InvitedAgent,
  ChannelSettings,
  ChannelSettingsPatch,
  ResolvedContextWindow,
  BenchChatSettings,
  BenchChatSettingsPatch,
  BlockResponses,
  BlockResponsePayload as BlockResponsePayloadWire,
  ReactionEmoji,
  ReactionSummary,
  Pinned,
  PinnedMessage,
} from "./api";
export { ChannelSettingsSurface } from "./channel-settings";
export {
  channelSettingsSections,
  contextWindowControlState,
  contextWindowPatchValue,
} from "./channel-settings";
export type {
  ChannelSettingsSection,
  ChannelSettingsSectionGroup,
  ChannelSettingsSectionId,
  ContextWindowMode,
} from "./channel-settings";
export { profileSubjectFromParticipant } from "./profile-subject";
export type { ProfileSubject } from "./profile-subject";

export { sharedChannelsWith } from "./shared-channels";
export type { SharedChannelSummary } from "./shared-channels";
export { findDirectChannelWith } from "./direct-channel";

export {
  createDefaultAgentChannel,
  findChannelByTitle,
  findDefinitionByAssetName,
  isChannelTitleMatch,
} from "./default-agent-channel";
export type {
  DefaultAgentChannel,
  DefaultAgentChannelConfig,
  EnsureDefaultAgentChannelResult,
} from "./default-agent-channel";

export { ArtifactChip } from "./artifact-chip";

export {
  TypingIndicator,
  parseTypingEvent,
  nextTypingState,
  isTypingStateExpired,
  typingLabel,
} from "./typing-indicator";
export type { TypingEvent, TypingState } from "./typing-indicator";
