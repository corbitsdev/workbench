// What's waiting on a person, composed on the client from Interchange's own
// approval and run views. The platform's `GET /approvals` carries ids, the
// tool snapshot and a status; the name of the agent that is asking lives on
// the run view (`definitionName`), the bench's name on the account's
// membership, and the human headline comes from `@corbits/approvals`'
// `headlineFor`. Composing those three here is what lets this app render an
// approval without a raw id ever reaching a rendered string, and without a
// sibling read of its own on the hub.

import { ApprovalResponse, WorkflowRunResponse } from "@intx/types";
import { useQueries } from "@tanstack/react-query";
import { type } from "arktype";

import type { APIQuery } from "@corbits/api-query";
import { headlineFor } from "@corbits/approvals/headline";

import { TenantApprovalsSchema, useAPIQuery } from "./api";
import { useBench } from "./bench-context";
import { tenantKeys } from "./query-client";

/** The display model every approval surface in this app renders. Not one
 * field on it holds an identifier a person would have to decode. */
export type ApprovalDisplay = {
  readonly id: string;
  readonly agentName: string;
  readonly headline: string;
  readonly arguments: Record<string, unknown>;
  readonly status: "pending" | "approved" | "rejected" | "timeout" | "expired";
  readonly createdAt: string;
};

/** A pending approval, named for where it landed. The name is absent, not
 * invented, when the account's membership list hasn't resolved. */
export type PendingApproval = ApprovalDisplay & {
  readonly benchName?: string;
};

type ApprovalRow = typeof ApprovalResponse.infer;

// Copy for the rare case where the naming read cannot answer: an approval is
// blocking an agent right now, so it is always shown — an unnamed asker is
// far better than a hidden decision.
const UNNAMED_AGENT = "An agent";

export function pendingApprovalsPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/approvals`;
}

function runViewPath(tenantId: string, runId: string): string {
  return `/api/tenants/${tenantId}/runs/${runId}`;
}

/**
 * The display name of the agent behind a run. Answers `UNNAMED_AGENT` rather
 * than failing when the run view is unreadable — a per-deployment approver
 * can hold the grant to resolve an approval without holding the read grant
 * on its run.
 */
async function fetchAgentName(
  tenantId: string,
  runId: string,
): Promise<string> {
  const response = await fetch(runViewPath(tenantId, runId), {
    headers: { accept: "application/json" },
  });
  if (!response.ok) return UNNAMED_AGENT;
  const parsed = WorkflowRunResponse(await response.json());
  if (parsed instanceof type.errors) return UNNAMED_AGENT;
  return parsed.definitionName;
}

function composeApproval(row: ApprovalRow, agentName: string): ApprovalDisplay {
  return {
    id: row.id,
    agentName,
    headline: headlineFor(row.toolDefinition, row.toolArguments),
    arguments: row.toolArguments,
    status: row.status,
    createdAt: row.createdAt,
  };
}

/**
 * Every approval pending on this bench, newest-first as the platform lists
 * them. One naming read per distinct run, cached by react-query, so a run
 * with several pending asks is named once.
 */
export function usePendingApprovals(
  tenantId: string | null,
): APIQuery<readonly PendingApproval[]> {
  const { memberships } = useBench();
  const list = useAPIQuery(
    tenantId === null ? "" : pendingApprovalsPath(tenantId),
    TenantApprovalsSchema,
  );
  const rows = list.kind === "ready" ? list.data.data : [];
  const runIds = [...new Set(rows.map((row) => row.runId))];
  const agentNames = useQueries({
    queries:
      tenantId === null
        ? []
        : runIds.map((runId) => ({
            queryKey: tenantKeys.runView(tenantId, runId),
            queryFn: () => fetchAgentName(tenantId, runId),
          })),
  });

  if (list.kind !== "ready") return list;
  // A half-named list would render the placeholder and then swap in real
  // names a tick later; wait instead.
  if (agentNames.some((name) => name.isPending)) return { kind: "loading" };

  const agentNameByRunId = new Map(
    runIds.map((runId, index) => [
      runId,
      agentNames[index]?.data ?? UNNAMED_AGENT,
    ]),
  );
  const membership =
    memberships.kind === "ready"
      ? memberships.data.data.find((row) => row.tenantId === tenantId)
      : undefined;
  const benchName = membership?.tenantName;

  return {
    kind: "ready",
    data: rows.map((row) => ({
      ...composeApproval(row, agentNameByRunId.get(row.runId) ?? UNNAMED_AGENT),
      ...(benchName !== undefined ? { benchName } : {}),
    })),
  };
}

/**
 * How many things need this bench's attention right now — the count the
 * shell's chip and the second column's signal render. `null` while unknown
 * (no bench selected yet, or the read hasn't resolved), so a caller never
 * mistakes "still loading" for "zero pending."
 */
export function usePendingApprovalCount(
  tenantId: string | null,
): number | null {
  const list = useAPIQuery(
    tenantId === null ? "" : pendingApprovalsPath(tenantId),
    TenantApprovalsSchema,
  );
  return list.kind === "ready" ? list.data.data.length : null;
}

export type ApprovalDetailResult =
  | { readonly kind: "ready"; readonly item: ApprovalDisplay }
  | { readonly kind: "forbidden" }
  | { readonly kind: "not-found" }
  | { readonly kind: "error"; readonly message: string };

/**
 * The chat approve card's live status read: one approval, in any status,
 * through the same composer the list uses. The grant this read is refused
 * on (403) is the same per-deployment grant approve and reject are gated
 * on, so a refusal here is proof the viewer cannot act on it.
 */
export async function getApprovalDetail(
  tenantId: string,
  approvalId: string,
): Promise<ApprovalDetailResult> {
  const response = await fetch(
    `/api/tenants/${tenantId}/approvals/${approvalId}`,
    { headers: { accept: "application/json" } },
  );
  if (response.status === 403) return { kind: "forbidden" };
  if (response.status === 404) return { kind: "not-found" };
  if (!response.ok) {
    return {
      kind: "error",
      message: `The server answered ${response.status} for this approval.`,
    };
  }
  const parsed = ApprovalResponse(await response.json());
  if (parsed instanceof type.errors) {
    return { kind: "error", message: parsed.summary };
  }
  return {
    kind: "ready",
    item: composeApproval(parsed, await fetchAgentName(tenantId, parsed.runId)),
  };
}
