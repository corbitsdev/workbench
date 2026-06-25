// Approval request API client.
//
// These routes proxy to the Interchange tenant approval endpoints
// (/api/tenants/:tenantId/approvals). The tenantId must be obtained
// from /api/v1/me before calling these functions.

const apiBase: string = import.meta.env.VITE_API_BASE_URL ?? "";

async function approvalsApiFetch<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = new URL(
    `/api/${path.replace(/^\//, "")}`,
    apiBase || window.location.origin,
  ).toString();
  const init: RequestInit = { method, credentials: "include" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw Object.assign(
      new Error((err as { error?: string }).error ?? `HTTP ${res.status}`),
      {
        status: res.status,
      },
    );
  }
  return res.json() as Promise<T>;
}

export type ApprovalStatus = "pending" | "approved" | "rejected";

export type Approval = {
  id: string;
  tenantId: string;
  principalId: string;
  agentId: string;
  sessionId: string;
  resource: string;
  action: string;
  context: Record<string, unknown> | null;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt: string | null;
};

export type ApproveScope = "once" | "always";

/**
 * List all pending approval requests for the given tenant.
 * Optionally filter by Interchange session ID on the client side.
 */
export async function listApprovals(tenantId: string): Promise<Approval[]> {
  return approvalsApiFetch<Approval[]>("GET", `tenants/${tenantId}/approvals`);
}

/**
 * Approve a pending approval request.
 *
 * `scope: 'once'` — one-time approval.
 * `scope: 'always'` — creates a persistent grant so the agent won't ask again.
 */
export async function approveRequest(
  tenantId: string,
  approvalId: string,
  scope: ApproveScope,
): Promise<Approval> {
  return approvalsApiFetch<Approval>(
    "POST",
    `tenants/${tenantId}/approvals/${approvalId}/approve`,
    { scope },
  );
}

/**
 * Reject a pending approval request with an optional feedback message.
 */
export async function rejectRequest(
  tenantId: string,
  approvalId: string,
  message?: string,
): Promise<Approval> {
  return approvalsApiFetch<Approval>(
    "POST",
    `tenants/${tenantId}/approvals/${approvalId}/reject`,
    message !== undefined ? { message } : {},
  );
}
