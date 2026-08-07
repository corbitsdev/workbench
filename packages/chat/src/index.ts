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
export { encodeParts, decodeParts, decodeMail } from "./codec";
export type { MailContent, MailReadContent, FetchBlob } from "./codec";

export {
  CHANNEL_WORKFLOW_ID,
  CHANNEL_SECTION_ID,
  CHANNEL_RELAY_STEP_ID,
  CHANNEL_RELAY_HANDLER,
  buildChannelWorkflow,
  serializeChannelWorkflow,
} from "./channel-workflow";
export type { ChannelWorkflowInput } from "./channel-workflow";

export {
  CHANNEL_CONTROL_NAMESPACE,
  ChannelControlPayload,
  EMPTY_CHANNEL_STATE,
  isControlMessage,
  parseControlPayload,
  applyControlPayload,
  planRelay,
} from "./relay";
export type {
  ChannelParticipantState,
  ControlApplyResult,
  RelayPlan,
} from "./relay";

export { presetForKind } from "./kinds";
export type { ChannelKindPreset } from "./kinds";

export { createChatRoutes } from "./routes";
export type {
  ChatPlatform,
  ChatChannelEvent,
  CreateChatRoutesDeps,
  LaunchedChannel,
  ListedMail,
  ListedMailItem,
  SentMail,
} from "./routes";

export { createDrizzleChatStore } from "./store";
export type { ChatDb, ChatStore } from "./store";
