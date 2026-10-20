// Browser-side wire contract — apps/web must not import server-only packages.

import { type } from "arktype";

// Strips undeclared keys deeply so agent-authored extras never reach a
// renderer that trusts them.

// No action labels or resolved state: those live on the approval record,
// never in the message, so an agent can't spoof a decision.
export const ApproveBlockData = type({
  approvalId: "string",
  title: "string",
  "risk?": "'low' | 'medium' | 'high'",
  "riskNote?": "string",
  "body?": "string",
}).onDeepUndeclaredKey("delete");
export type ApproveBlockData = typeof ApproveBlockData.infer;
