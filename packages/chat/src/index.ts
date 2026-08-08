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
export type {
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
export type { ChatDb, ChatStore } from "./store";

export { createNoopInferenceRoutes } from "./noop-inference";
export {
  launchAndJoinAgent,
  sendChannelMessage,
  startWorkflowCommand,
} from "./channel-service";
export type {
  LaunchAndJoinAgentDeps,
  LaunchAndJoinAgentInput,
  LaunchAndJoinAgentResult,
  SendChannelMessageDeps,
  SendChannelMessageInput,
  SendChannelMessageResult,
  StartWorkflowCommandDeps,
  StartWorkflowCommandInput,
  StartWorkflowCommandResult,
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

export { createHubChatPlatform } from "./platform-adapter";
export type {
  CreateHubChatPlatformDeps,
  HubChatPlatform,
} from "./platform-adapter";

export { createChatOrchestrator } from "./chat-orchestrator";
export type {
  ChatOrchestrator,
  ChatOrchestratorDeps,
} from "./chat-orchestrator";
