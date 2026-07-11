import { type } from "arktype";
import { getLogger } from "@intx/log";
import type {
  ToolCall,
  ToolDefinition,
  ToolResult,
  ToolRunner,
} from "@intx/types/runtime";

const logger = getLogger(["sidecar", "approval-gate"]);

type DefinedRunner = ToolRunner & { definitions: ToolDefinition[] };

export type ApprovalDecision = { approved: boolean; message?: string };

/**
 * Asks the tenant principal to approve a single gated tool call and resolves
 * the decision. This is the harness-side enforcement of human-in-the-loop:
 * the gated tool cannot run until a human resolves the request in the
 * ReviewGate UI, which shows the full tool arguments (deploy target, note
 * body) so the human approves the concrete action — the runner wrapper passes
 * `call.arguments` into the approval record for exactly this reason.
 */
export type ApproveFn = (
  call: ToolCall,
  signal: AbortSignal,
) => Promise<ApprovalDecision>;

export type ApprovalGateContext = {
  hubHttpUrl: string;
  sidecarToken: string;
  tenantId: string;
  agentId: string;
  principalId: string;
  sessionId: string;
};

const ApprovalRecord = type({
  id: "string",
  status: "'pending' | 'approved' | 'rejected'",
  message: "string | null",
});

const POLL_INTERVAL_MS = 3000;

class HubRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

class ApprovalParseError extends Error {}

type Fetch = typeof fetch;

async function hubJson(
  fetcher: Fetch,
  ctx: ApprovalGateContext,
  method: string,
  path: string,
  signal: AbortSignal,
  body?: unknown,
): Promise<typeof ApprovalRecord.infer> {
  const res = await fetcher(`${ctx.hubHttpUrl.replace(/\/$/, "")}${path}`, {
    method,
    signal,
    headers: {
      Authorization: `Bearer ${ctx.sidecarToken}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HubRequestError(
      res.status,
      `hub approvals request failed: ${String(res.status)} ${text}`,
    );
  }
  const parsed = ApprovalRecord(await res.json());
  if (parsed instanceof type.errors) {
    throw new ApprovalParseError(
      `invalid approval record from hub: ${parsed.summary}`,
    );
  }
  return parsed;
}

/**
 * A poll fault is permanent (stop waiting) if the record is gone, the request
 * is client-rejected (4xx), or the payload is malformed. A transient fault
 * (5xx/network) is retried — a hub blip must not abandon a request a human may
 * still resolve.
 */
function isPermanentPollFault(err: unknown): boolean {
  return (
    err instanceof ApprovalParseError ||
    (err instanceof HubRequestError && err.status < 500)
  );
}

/**
 * Build the approval function over the hub approvals rail (the same
 * `/api/internal/approvals` endpoint + ReviewGate UI `ask_principal` uses):
 * create a record, then poll until a human approves or rejects.
 */
export function createApprovalClient(
  ctx: ApprovalGateContext,
  opts: { fetcher?: Fetch; pollIntervalMs?: number } = {},
): ApproveFn {
  const fetcher = opts.fetcher ?? fetch;
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  return async (call, signal) => {
    const created = await hubJson(
      fetcher,
      ctx,
      "POST",
      "/api/internal/approvals",
      signal,
      {
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        principalId: ctx.principalId,
        sessionId: ctx.sessionId,
        action: `Run ${call.name}`,
        resource: `tool:${call.name}`,
        context: call.arguments,
      },
    );

    while (!signal.aborted) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, pollIntervalMs);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      });
      if (signal.aborted) break;

      let current: typeof ApprovalRecord.infer;
      try {
        current = await hubJson(
          fetcher,
          ctx,
          "GET",
          `/api/internal/approvals/${created.id}?tenantId=${encodeURIComponent(ctx.tenantId)}`,
          signal,
        );
      } catch (err) {
        if (isPermanentPollFault(err)) throw err;
        continue;
      }
      if (current.status !== "pending") {
        return {
          approved: current.status === "approved",
          ...(current.message !== null ? { message: current.message } : {}),
        };
      }
    }

    return { approved: false, message: "approval request was cancelled" };
  };
}

/**
 * Wrap a tool runner so that calls to `gatedTools` (LLM-safe names) require
 * human approval before they execute; everything else passes through
 * untouched. The wrapper IS the executor of the gated tool, so the model
 * cannot route around it. The approval record carries the concrete
 * `call.arguments` (via `createApprovalClient`), so ReviewGate shows the human
 * exactly what will run — the reason approval lives at the runner seam rather
 * than the argument-blind authz callback.
 */
export function createApprovalGatedRunner(
  inner: DefinedRunner,
  opts: { gatedTools: ReadonlySet<string>; approve: ApproveFn },
): DefinedRunner {
  return {
    definitions: inner.definitions,
    async run(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
      if (!opts.gatedTools.has(call.name)) return inner.run(call, signal);

      let decision: ApprovalDecision;
      try {
        decision = await opts.approve(call, signal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("Approval request failed for {tool}: {message}", {
          tool: call.name,
          message,
        });
        return {
          callId: call.id,
          content: { error: `approval could not be obtained: ${message}` },
          isError: true,
        };
      }
      if (!decision.approved) {
        const reason = decision.message ? `: ${decision.message}` : ".";
        return {
          callId: call.id,
          content: { error: `${call.name} was not approved${reason}` },
          isError: true,
        };
      }
      return inner.run(call, signal);
    },
  };
}
