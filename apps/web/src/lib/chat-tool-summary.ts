import {
  friendlyToolSummary,
  toolOperationKey,
} from "@workbench/agents/browser";
import type { ToolCall } from "@workbench/chat";
import {
  mailSendToolSummaryHeadline,
  type ApprovalDisplayLookups,
} from "./approval-display";

/**
 * Chat `formatToolSummary` that humanizes `mail_send` recipients the same way as
 * ReviewGate when member/agent lookups are available.
 */
export function createChatToolSummaryFormatter(
  lookups: ApprovalDisplayLookups,
  lookupsLoading: boolean,
): (call: ToolCall) => string {
  return (call) => {
    if (toolOperationKey(call.name) === "mail_send") {
      return mailSendToolSummaryHeadline(
        call.arguments?.to,
        lookups,
        lookupsLoading,
      );
    }
    return friendlyToolSummary(call);
  };
}