// Approval request API client.
//
// These routes are served by the workbench hub's own approvals router
// (createApprovalsRouter), mounted under /api/v1
// (/api/v1/tenants/:tenantId/approvals). Requests go through the shared api()
// client so the /api/v1 prefix and error handling stay single-sourced with the
// rest of the app. The tenantId must be obtained from /api/v1/me before calling
// these functions.

import { type } from "arktype";
import { api, buildEventSourceUrl } from "./api";
import { hubFetch } from "./hub-api";
import { subscribeSharedEventStream } from "./shared-event-stream";

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

// A change notification pushed over the workbench-owned approvals SSE stream —
// never the approval data itself. The client refetches the ownership-scoped
// list route on each event.
export const ApprovalEventSchema = type({
  tenantId: "string",
  sessionId: "string | null",
  kind: "'created' | 'resolved'",
});
export type ApprovalEvent = typeof ApprovalEventSchema.infer;

const APPROVALS_STREAM_EVENT = "approvals";

/**
 * Subscribe to the tenant's approval change notifications over SSE. Shares one
 * ref-counted EventSource per stream URL (see shared-event-stream). Each valid
 * event invokes `onEvent`; malformed frames are dropped. `onError` fires once if
 * the connection never opens (terminal failure) so the caller can react instead
 * of silently going quiet. Returns an unsubscribe function that closes the
 * connection when the last subscriber leaves.
 */
export function subscribeApprovals(
  tenantId: string,
  onEvent: (event: ApprovalEvent) => void,
  onError?: (error: Error) => void,
): () => void {
  const url = buildEventSourceUrl(`tenants/${tenantId}/approvals/stream`);
  return subscribeSharedEventStream(
    url,
    APPROVALS_STREAM_EVENT,
    (raw) => {
      const parsed = ApprovalEventSchema(raw);
      if (parsed instanceof type.errors) return;
      onEvent(parsed);
    },
    onError,
  );
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

// ─── Native rail (Interchange suspension) ──────────────────────────
//
// The native approval rail lives on Interchange's un-versioned tenant routes
// (`/api/tenants/:tenantId/...`), not the workbench `/api/v1` router, so these
// go through hubFetch. The list is a workbench-owned read (Interchange leaves
// its own list route a 501 stub); approve/reject are Interchange's mounted
// routes. A native row is shaped by Interchange's `ApprovalResponse` — it
// carries a tool snapshot (null until the upstream suspend-time plumbing lands)
// rather than the legacy row's `resource`/`action`/`context`.

export const NativeApprovalSchema = type({
  id: "string",
  tenantId: "string",
  deploymentId: "string",
  runId: "string",
  agentAddress: "string",
  correlationId: "string",
  toolDefinition: "Record<string, unknown> | null",
  toolArguments: "Record<string, unknown> | null",
  scope: "'once' | 'always' | null",
  status: "'pending' | 'approved' | 'rejected' | 'timeout' | 'expired'",
  timeoutAt: "string | null",
  resolvedAt: "string | null",
  createdAt: "string",
  updatedAt: "string",
});
export type NativeApproval = typeof NativeApprovalSchema.infer;

const NativeApprovalArraySchema = NativeApprovalSchema.array();

function parseNativeApproval(raw: unknown): NativeApproval {
  const parsed = NativeApprovalSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid native approval response: ${parsed.summary}`);
  }
  return parsed;
}

function parseNativeApprovals(raw: unknown): NativeApproval[] {
  const parsed = NativeApprovalArraySchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid native approvals response: ${parsed.summary}`);
  }
  return parsed;
}

/**
 * List the tenant's pending native approvals (the native rail's decision
 * surface). Tenant-scoped server-side behind Interchange's resolveTenant.
 */
export async function listNativeApprovals(
  tenantId: string,
): Promise<NativeApproval[]> {
  const raw = await hubFetch<unknown>(
    "GET",
    `tenants/${tenantId}/native-approvals`,
  );
  return parseNativeApprovals(raw);
}

/**
 * Approve a pending native approval as a one-time grant. Interchange's approve
 * route requires a scope; the workbench decision surface only issues `once`
 * (scope `always` is not yet supported upstream — the suspend path does not
 * capture the tool identity a standing grant needs).
 */
export async function approveNativeRequest(
  tenantId: string,
  approvalId: string,
): Promise<NativeApproval> {
  const raw = await hubFetch<unknown>(
    "POST",
    `tenants/${tenantId}/approvals/${approvalId}/approve`,
    { scope: "once" },
  );
  return parseNativeApproval(raw);
}

/**
 * Reject a pending native approval with an optional feedback message.
 */
export async function rejectNativeRequest(
  tenantId: string,
  approvalId: string,
  message?: string,
): Promise<NativeApproval> {
  const raw = await hubFetch<unknown>(
    "POST",
    `tenants/${tenantId}/approvals/${approvalId}/reject`,
    message !== undefined ? { message } : {},
  );
  return parseNativeApproval(raw);
}
