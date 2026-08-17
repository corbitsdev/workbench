export const CHAT_PACKAGE_NAME = "@corbits/chat";

export {
  TextPart,
  ReasoningPart,
  ToolTracePart,
  BlockPart,
  FilePart,
  EventPart,
  Part,
  parsePart,
} from "./parts";
export {
  ApproveBlockData,
  StepsBlockData,
  MetricsBlockData,
  PollBlockData,
  FormBlockData,
  StreamBlockData,
  parseBlock,
} from "./blocks";
export type { Block, BlockParseResult } from "./blocks";
export { encodeParts, decodeParts, decodeMail, senderOf } from "./codec";
export type {
  MailContent,
  MailReadContent,
  FetchBlob,
  MailSender,
} from "./codec";

export {
  CHANNEL_HOST_WORKFLOW_ID,
  CHANNEL_HOST_STEP_ID,
  CHANNEL_HOST_SYSTEM_PROMPT,
  buildChannelHostWorkflow,
  serializeChannelHostWorkflow,
} from "./channel-workflow";
export type { ChannelHostWorkflowInput } from "./channel-workflow";
export {
  channelHostAssetName,
  isChannelHostDefinitionName,
} from "./channel-host-naming";

export {
  CHANNEL_CONTROL_NAMESPACE,
  ChannelControlPayload,
  EMPTY_CHANNEL_STATE,
  isControlMessage,
  parseControlPayload,
  applyControlPayload,
} from "./settings-control";
export type {
  ChannelParticipantState,
  ControlApplyResult,
} from "./settings-control";

export { presetForKind } from "./kinds";
export type { ChannelKindPreset } from "./kinds";

export { localPartOf, domainOf } from "./agent-address";
export { isAgentAddress, mentionedParticipants } from "./mentions";
export {
  ParticipantEntry,
  ParticipantsSetting,
  parseParticipants,
  handleFromName,
  dedupeHandle,
  addParticipant,
} from "./participants";
export type { ParticipantRecord } from "./participants";

export { createChatRoutes } from "./routes";
export type { CreateChatRoutesDeps } from "./routes";

export { createChannelSubscriberRegistry } from "./channel-events";
export type { ChannelSubscriberRegistry } from "./channel-events";
export type {
  ChannelActivitySummary,
  ChannelEvents,
  ChannelLauncher,
  ChannelMail,
  ChatPlatform,
  ChatChannelEvent,
  InvitableDefinition,
  LaunchedChannel,
  LaunchedInvite,
  ListedMail,
  ListedMailItem,
  SentMail,
} from "./platform-port";

export { createDrizzleChatStore, createInMemoryChatStore } from "./store";
export type { ChatDb, ChatStore, ChannelByParticipantAddress } from "./store";

export {
  createInMemoryThreadStore,
  createDrizzleThreadStore,
  createDeliveryThread,
  resolveTargetThread,
} from "./threads";
export type {
  ThreadStore,
  ChannelThread,
  ThreadKind,
  CreateDeliveryThreadInput,
  OpenReplyThreadInput,
  AssignMessageInput,
  ThreadDb,
} from "./threads";

export {
  createInMemoryBlockResponseStore,
  createDrizzleBlockResponseStore,
  aggregatePollResponses,
} from "./block-responses";
export type {
  BlockResponsePayload,
  BlockResponseRow,
  BlockResponseStore,
  BlockResponseAggregation,
  BlockResponseDb,
  UpsertBlockResponseInput,
} from "./block-responses";

export { REACTION_EMOJI, isKnownReactionEmoji } from "./reaction-emoji";
export type { ReactionEmoji } from "./reaction-emoji";

export {
  createInMemoryReactionStore,
  createDrizzleReactionStore,
  aggregateReactions,
  aggregateReactionsByMessage,
} from "./reactions";
export type {
  ReactionRow,
  ReactionStore,
  ReactionSummary,
  ReactionDb,
  ToggleReactionInput,
  ToggleReactionResult,
} from "./reactions";

export { createInMemoryPinStore, createDrizzlePinStore } from "./pins";
export type { PinRow, PinStore, PinDb, PinMessageInput } from "./pins";

export { createNoopInferenceRoutes } from "./noop-inference";
export { joinRunParticipant } from "./run-participant";
export type {
  JoinRunParticipantDeps,
  JoinRunParticipantInput,
} from "./run-participant";
export {
  launchAndJoinAgent,
  dispatchGreetingKickoff,
  greetingKickoffBrief,
  sendChannelMessage,
  startWorkflowCommand,
  provisionSpaceChannel,
} from "./channel-service";
export type {
  LaunchAndJoinAgentDeps,
  LaunchAndJoinAgentInput,
  LaunchAndJoinAgentResult,
  DispatchGreetingKickoffDeps,
  DispatchGreetingKickoffInput,
  SendChannelMessageDeps,
  SendChannelMessageInput,
  SendChannelMessageResult,
  StartWorkflowCommandDeps,
  StartWorkflowCommandInput,
  StartWorkflowCommandResult,
  ProvisionSpaceChannelDeps,
  ProvisionSpaceChannelInput,
  ProvisionSpaceChannelResult,
} from "./channel-service";

export {
  createDrizzleChannelTenancyStore,
  createInMemoryChannelTenancyStore,
} from "./channel-tenancy";
export type {
  ChannelTenancyDb,
  ChannelTenancyRow,
  ChannelTenancyStore,
  CreateChannelTenantInput,
  CreateChannelTenantResult,
  MoveChannelTenancyInput,
} from "./channel-tenancy";

export { createChannelTenancyRoutes } from "./channel-tenancy-routes";
export type { CreateChannelTenancyRoutesDeps } from "./channel-tenancy-routes";

export {
  createDrizzleFederationTrustStore,
  createInMemoryFederationTrustStore,
} from "./federation-trust";
export type {
  FederationTrustDb,
  FederationTrustStore,
} from "./federation-trust";

export {
  createDrizzleChannelShareStore,
  createInMemoryChannelShareStore,
  monogramFromName,
} from "./channel-share";
export type {
  AddShareMemberInput,
  ChannelShareDb,
  ChannelShareRow,
  ChannelShareStore,
  ChannelShareStoreDeps,
  CreateShareInput,
  CreateShareOutcome,
} from "./channel-share";

export { createHubChatPlatform } from "./platform-adapter";
export type {
  CreateHubChatPlatformDeps,
  HubChatPlatform,
} from "./platform-adapter";

export {
  createArtifactDeliveryHandler,
  createChatOrchestrator,
} from "./chat-orchestrator";
export type {
  ChatOrchestrator,
  ChatOrchestratorDeps,
} from "./chat-orchestrator";

export {
  createDrizzleWriteClaimStore,
  createInMemoryWriteClaimStore,
} from "./write-claims";
export type {
  WriteClaim,
  WriteClaimDb,
  WriteClaimStore,
  WriteClaimSurface,
} from "./write-claims";

export {
  createChannelHostInferencePreferencesResolver,
  listConnectedProviders,
} from "./inference-preferences";
export type { ConnectedProviderLister } from "./inference-preferences";

export {
  artifactPartsForFinalizedTurn,
  artifactPartsForToolCall,
} from "./artifact-delivery";

export { createWorkflowParticipantRoutes } from "./workflow-participant-routes";
export type {
  CreateWorkflowParticipantRoutesDeps,
  WorkflowParticipantEnv,
  WorkflowParticipantRunScope,
  WorkflowRunAuthenticator as WorkflowParticipantRunAuthenticator,
} from "./workflow-participant-routes";
