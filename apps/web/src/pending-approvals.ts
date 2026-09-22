// Composes approval + run + membership views client-side so this app
// renders an approval without a raw id ever reaching a rendered string.

import { ApprovalResponse, WorkflowRunResponse } from "@intx/types";
import { useQueries, useQuery } from "@tanstack/react-query";
import { type } from "arktype";

import type { APIQuery } from "@/lib/api-query";
import { argumentsSummaryFor, headlineFor, toolNameFor } from "@corbits/approvals/headline";

import { listChatAgents } from "./chat/threads-api";
import { TenantApprovalsSchema, useAPIQuery } from "./api";
import { useBench } from "./bench-context";
import { tenantKeys } from "./query-client";

/** The display model every approval surface in this app renders. Not one
 * field on it holds an identifier a person would have to decode. */
export type ApprovalDisplay = {
  readonly id: string;
  /** The live run address of the agent that is asking. The chat page filters
   * on it to show only the asks its own agent raised. */
  readonly agentAddress: string;
  readonly agentName: string;
  readonly headline: string;
  /** The tool being called, e.g. `write_file` -- absent only when the route's
   * tool snapshot carried no name. */
  readonly toolName?: string;
  /** A compact, truncated rendering of the call's arguments -- always plain
   * text, never markup, since the arguments are untrusted agent output. */
  readonly argumentsSummary?: string;
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

// Answers `UNNAMED_AGENT` rather than failing when the run view is
// unreadable — an approver can lack the read grant on the run itself.
async function fetchAgentName(tenantId: string, runId: string): Promise<string> {
  const response = await fetch(runViewPath(tenantId, runId), {
    headers: { accept: "application/json" },
  });
  if (!response.ok) return UNNAMED_AGENT;
  const parsed = WorkflowRunResponse(await response.json());
  if (parsed instanceof type.errors) return UNNAMED_AGENT;
  return parsed.definitionName;
}

function composeApproval(row: ApprovalRow, agentName: string): ApprovalDisplay {
  const toolName = toolNameFor(row.toolDefinition);
  const argumentsSummary = argumentsSummaryFor(row.toolDefinition, row.toolArguments);
  return {
    id: row.id,
    agentAddress: row.agentAddress,
    agentName,
    headline: headlineFor(row.toolDefinition, row.toolArguments),
    ...(toolName !== undefined ? { toolName } : {}),
    ...(argumentsSummary !== undefined ? { argumentsSummary } : {}),
    arguments: row.toolArguments,
    status: row.status,
    createdAt: row.createdAt,
  };
}

// One naming read per distinct run, cached by react-query, so a run with
// several pending asks is named once.
export function usePendingApprovals(
  tenantId: string | null,
  options?: { readonly refetchInterval?: number | false },
): APIQuery<readonly PendingApproval[]> {
  const { memberships } = useBench();
  const list = useAPIQuery(
    tenantId === null ? "" : pendingApprovalsPath(tenantId),
    TenantApprovalsSchema,
    options,
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
  // The roster's join (deployments -> runs -> assets) names an agent by
  // every address it has ever run under, including a just-created one the
  // run view above can't resolve (the approver may lack a read grant on that
  // run). Same key the agents page uses, so this is usually a cache hit.
  const roster = useQuery({
    queryKey: tenantKeys.agents(tenantId ?? ""),
    queryFn: () => listChatAgents(tenantId as string),
    enabled: tenantId !== null,
  });

  if (list.kind !== "ready") return list;
  // A half-named list would render the placeholder and then swap in real
  // names a tick later; wait instead.
  if (agentNames.some((name) => name.isPending)) return { kind: "loading" };
  if (roster.isPending) return { kind: "loading" };

  const agentNameByRunId = new Map(
    runIds.map((runId, index) => [runId, agentNames[index]?.data ?? UNNAMED_AGENT]),
  );
  const rosterNameByAddress = new Map<string, string>();
  for (const agent of roster.data ?? []) {
    for (const address of agent.addresses) {
      rosterNameByAddress.set(address, agent.name);
    }
  }
  const nameForRow = (row: ApprovalRow): string => {
    const fromRun = agentNameByRunId.get(row.runId) ?? UNNAMED_AGENT;
    if (fromRun !== UNNAMED_AGENT) return fromRun;
    return rosterNameByAddress.get(row.agentAddress) ?? UNNAMED_AGENT;
  };
  const membership =
    memberships.kind === "ready"
      ? memberships.data.data.find((row) => row.tenantId === tenantId)
      : undefined;
  const benchName = membership?.tenantName;

  return {
    kind: "ready",
    data: rows.map((row) => ({
      ...composeApproval(row, nameForRow(row)),
      ...(benchName !== undefined ? { benchName } : {}),
    })),
  };
}

// `null` while unknown, so a caller never mistakes "still loading" for
// "zero pending."
export function usePendingApprovalCount(tenantId: string | null): number | null {
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

// A 403 here is proof the viewer cannot act on it — the same
// per-deployment grant approve/reject are gated on.
export async function getApprovalDetail(
  tenantId: string,
  approvalId: string,
): Promise<ApprovalDetailResult> {
  const response = await fetch(`/api/tenants/${tenantId}/approvals/${approvalId}`, {
    headers: { accept: "application/json" },
  });
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
