// ask_principal tool — suspends the agent until the tenant principal
// (human or another agent) approves or rejects the proposed action.
//
// The tool:
//   1. POSTs to the hub internal approvals endpoint to create a record.
//   2. Polls GET /api/internal/approvals/:id until status !== 'pending'.
//   3. Returns the decision so the agent can act on it.
//
// The hub exposes separate user-facing routes (list/approve/reject) that
// the ReviewGate UI calls. This tool uses the internal route authenticated
// with the sidecar token.

import { tool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";

export type ApprovalStatus = "pending" | "approved" | "rejected";

type ApprovalRecord = {
  id: string;
  status: ApprovalStatus;
  message: string | null;
};

export type AskPrincipalToolOpts = {
  hubHttpUrl: string;
  sidecarToken: string;
  tenantId: string;
  agentId: string;
  principalId: string;
  pollIntervalMs?: number;
};

class HubRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function fetchHub<T>(
  hubHttpUrl: string,
  sidecarToken: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${hubHttpUrl.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${sidecarToken}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HubRequestError(
      res.status,
      `Hub request failed: ${res.status} ${text}`,
    );
  }
  return res.json() as Promise<T>;
}

export function createAskPrincipalTool(opts: AskPrincipalToolOpts): AgentTool {
  const {
    hubHttpUrl,
    sidecarToken,
    tenantId,
    agentId,
    principalId,
    pollIntervalMs = 3000,
  } = opts;

  return tool({
    definition: {
      name: "ask_principal",
      description:
        "Pause and ask the tenant principal (human or agent) whether to proceed with an action. The agent waits until the principal approves or rejects before continuing.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description:
              "Plain-language description of the action you want to take.",
          },
          resource: {
            type: "string",
            description:
              'The resource the action targets (e.g. "email://send", "artifact://publish").',
          },
          context: {
            type: "object",
            description:
              "Optional structured context that helps the principal decide.",
            additionalProperties: true,
          },
        },
        required: ["action", "resource"],
      },
    },
    handler: async (call, signal) => {
      const args = call.arguments as {
        action: string;
        resource: string;
        context?: Record<string, unknown>;
      };

      let approval: ApprovalRecord;
      try {
        approval = await fetchHub<ApprovalRecord>(
          hubHttpUrl,
          sidecarToken,
          "POST",
          "/api/internal/approvals",
          {
            tenantId,
            agentId,
            principalId,
            action: args.action,
            resource: args.resource,
            context: args.context ?? null,
          },
        );
      } catch (err) {
        return {
          callId: call.id,
          content:
            err instanceof Error
              ? err.message
              : "Failed to create approval request.",
          isError: true,
        };
      }

      // Poll until resolved or aborted.
      while (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, pollIntervalMs);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            resolve();
          });
        });

        if (signal.aborted) break;

        try {
          const current = await fetchHub<ApprovalRecord>(
            hubHttpUrl,
            sidecarToken,
            "GET",
            `/api/internal/approvals/${approval.id}?tenantId=${encodeURIComponent(tenantId)}`,
          );

          if (current.status !== "pending") {
            const verdict =
              current.status === "approved" ? "Approved" : "Rejected";
            const detail = current.message ? `: ${current.message}` : ".";
            return { callId: call.id, content: `${verdict}${detail}` };
          }
        } catch (err) {
          // Permanent errors (404 = record gone, 401/403 = auth failure) — abort immediately.
          if (
            err instanceof HubRequestError &&
            (err.status === 404 || err.status < 500)
          ) {
            return {
              callId: call.id,
              content: `Approval poll failed permanently: ${err.message}`,
              isError: true,
            };
          }
          // Transient (5xx, network) — keep waiting.
        }
      }

      return {
        callId: call.id,
        content: "Approval request cancelled.",
        isError: true,
      };
    },
  });
}
