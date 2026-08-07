export { ChatWorkspace } from "./chat-workspace";
export type { TenantResolution } from "./chat-workspace";

export { ChannelTimeline } from "./timeline";
export type { CurrentUser } from "./timeline";
export { Composer } from "./composer";
export { ChatSidebar } from "./sidebar";
export { NewChannelDialog } from "./new-channel-dialog";
export { InviteAgentDialog } from "./invite-agent-dialog";

export { useChannelStream } from "./use-channel-stream";
export type { ChannelStreamState } from "./use-channel-stream";

export {
  activeMentionQuery,
  filterMentionCandidates,
  insertMention,
  mentionCandidatesFromParticipants,
} from "./mentions";
export type { MentionCandidate, MentionQuery } from "./mentions";

export { CHAT_STRINGS } from "./strings";

export {
  TextPart,
  ReasoningPart,
  ToolTracePart,
  BlockPart,
  FilePart,
  EventPart,
  Part,
  ChannelKind,
  MessageSender,
  ParticipantRecord,
  ChatApiError,
  listChannels,
  createChannel,
  listMessages,
  sendMessage,
  putReadState,
  listDeployedAgents,
  listInvitableDefinitions,
  inviteAgent,
  channelStreamUrl,
  deploymentDisplayName,
} from "./api";
export type {
  Channel,
  MessageItem,
  MessagesResponse,
  Deployment,
  InvitableDefinition,
  InvitedAgent,
} from "./api";
