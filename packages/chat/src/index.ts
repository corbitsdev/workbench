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
export type {
  ChatPlatform,
  ChatChannelEvent,
  CreateChatRoutesDeps,
  InvitableDefinition,
  LaunchedChannel,
  LaunchedInvite,
  ListedMail,
  ListedMailItem,
  SentMail,
} from "./routes";

export { createDrizzleChatStore, createInMemoryChatStore } from "./store";
export type { ChatDb, ChatStore } from "./store";

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
