export {
  ChatRoleSchema,
  ChatMessageStatusSchema,
  ChatMessageKindSchema,
  ToolCallSchema,
  ChatImageSchema,
  ChatAttachmentSchema,
  ChatMessageSchema,
  QuickReplySchema,
  type ChatRole,
  type ChatMessageStatus,
  type ChatMessage,
  type ChatMessageKind,
  type ChatImage,
  type ChatAttachment,
  type ToolCall,
  type QuickReply,
  type ChatDockState,
  type ChatOpenState,
  type ChatLauncherPosition,
  type ChatAgentIdentity,
  type ChatActivity,
} from "./types";
export {
  compactMessages,
  type CompactedItem,
  type MessageItem,
  type CollapsedGroupItem,
} from "./compactMessages";
export { CollapsedGroup, type CollapsedGroupProps } from "./CollapsedGroup";

export {
  DocumentActionsSchema,
  UIResponseSchema,
  type UIBlock,
  type UIResponse,
  type DocumentActions,
  type ExtractedUIBlock,
  parseToolResult,
  extractUIBlockFromText,
  isUIBlock,
  UIBlockView,
  type UIBlockViewProps,
  DockRunInputSchema,
  DockRunPhaseSchema,
  DockStepPhaseSchema,
  dockRunBlocks,
  progressStateForStepPhase,
  type DockRunInput,
  type DockRunPhase,
  type DockRunStep,
  type DockStepPhase,
  pendingGateForRun,
  routeConversationSignal,
  type GateStepInput,
  type PendingGate,
  type SignalRouting,
} from "@workbench/blocks";
export { MessageBubble, type MessageBubbleProps } from "./MessageBubble";
export { AgentTurn, type AgentTurnProps } from "./AgentTurn";
export { ActivityBlock, type ActivityBlockProps } from "./ActivityBlock";
export {
  splitReasoningSteps,
  toSingleLine,
  rollingReasoningLabel,
} from "./reasoning-summary";
export {
  readReasoningExpanded,
  readReasoningExpandedForDisplay,
  writeReasoningExpanded,
  clearReasoningExpanded,
  reasoningExpandedMessageKey,
  reconcileReasoningExpandedAliases,
  migrateReasoningExpandedSlotKeys,
  type ReasoningExpandedMap,
} from "./reasoning-expanded-prefs";
export {
  MYRA_AGED_HISTORY_MS,
  isMyraHistoryAged,
} from "./aged-history";
export {
  ToolNarrative,
  type ToolNarrativeProps,
  type ToolMarkerRenderContext,
} from "./ToolNarrative";
export { QuickReplyChips, type QuickReplyChipsProps } from "./QuickReplyChips";
export {
  ChatInput,
  type ChatInputProps,
  type MentionCandidate,
} from "./ChatInput";
export {
  validateFiles,
  formatBytes,
  type AttachmentPolicy,
  type PendingAttachment,
  type ValidateResult,
} from "./attachments";
export {
  ChatThread,
  type ChatThreadProps,
  type ThreadInsert,
} from "./ChatThread";
export { ChatPanel, type ChatPanelProps } from "./ChatPanel";
export { ChatLauncher, type ChatLauncherProps } from "./ChatLauncher";
export { FloatingChat, type FloatingChatProps } from "./FloatingChat";
export {
  DockedChatBar,
  type DockedChatBarProps,
  DOCKED_BAR_HEIGHT,
  DOCKED_BAR_BOTTOM,
  DOCKED_BAR_TOTAL_HEIGHT,
} from "./DockedChatBar";
export { UrlImageCard, type UrlImageCardProps } from "./UrlImageCard";
export { MessageFeedback, type MessageFeedbackProps } from "./MessageFeedback";
export type { FeedbackSubjectKind } from "./feedback-types";
