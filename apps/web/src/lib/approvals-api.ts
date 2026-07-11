// Approval request API client.
//
// These routes are served by the workbench hub's own approvals router
// (createApprovalsRouter), mounted under /api/v1
// (/api/v1/tenants/:tenantId/approvals). Requests go through the shared api()
// client so the /api/v1 prefix and error handling stay single-sourced with the
// rest of the app. The tenantId must be obtained from /api/v1/me before calling
// these functions.

import { type } from "arktype";
import { api } from "./api";

export const ApprovalSchema = type({
  id: "string",
  tenantId: "string",
  principalId: "string",
  agentId: "string",
  sessionId: "string | null",
  resource: "string",
  action: "string",
  context: "Record<string, unknown> | null",
  status: "'pending' | 'approved' | 'rejected'",
  message: "string | null",
  createdAt: "string",
  resolvedAt: "string | null",
});
export type Approval = typeof ApprovalSchema.infer;
export type ApprovalStatus = Approval["status"];

const ApprovalArraySchema = ApprovalSchema.array();

function parseApproval(raw: unknown): Approval {
  const parsed = ApprovalSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid approval response: ${parsed.summary}`);
  }
  return parsed;
}

function parseApprovals(raw: unknown): Approval[] {
  const parsed = ApprovalArraySchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid approvals response: ${parsed.summary}`);
  }
  return parsed;
}

/**
 * List the pending approval requests the caller owns for the given tenant.
 */
export async function listApprovals(tenantId: string): Promise<Approval[]> {
  const raw = await api<unknown>("GET", `tenants/${tenantId}/approvals`);
  return parseApprovals(raw);
}

/**
 * Approve a pending approval request. The approve endpoint reads no request
 * body — the approval is resolved as a one-time grant server-side.
 */
export async function approveRequest(
  tenantId: string,
  approvalId: string,
): Promise<Approval> {
  const raw = await api<unknown>(
    "POST",
    `tenants/${tenantId}/approvals/${approvalId}/approve`,
  );
  return parseApproval(raw);
}

/**
 * Reject a pending approval request with an optional feedback message.
 */
export async function rejectRequest(
  tenantId: string,
  approvalId: string,
  message?: string,
): Promise<Approval> {
  const raw = await api<unknown>(
    "POST",
    `tenants/${tenantId}/approvals/${approvalId}/reject`,
    message !== undefined ? { message } : undefined,
  );
  return parseApproval(raw);
}
