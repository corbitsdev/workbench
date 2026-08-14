// The one piece of this workflow that reaches the Library engine: an
// honest status report for a run that started no `process-granola-call`
// children — either because it had no way to reach Granola at all, or
// because it found nothing new to process. Kept inside the workflow
// package rather than a shared tool package — this behavior is specific
// to this workflow, not a reusable integration — following the same
// "workflow-specific logic lives in the definition" convention
// `pain-point-collateral`'s and `reddit-opportunity-scanner`'s
// finalize-tool.ts files establish.
//
// Not approval-gated: a status report has nothing a human needs to
// confirm or reject, only an honest account of what this run actually
// found — the same reasoning `reddit-opportunity-scanner`'s
// `reddit_opportunity_scanner_report_no_results` tool documents for its
// own no-data path (see that package's `finalize-tool.ts` header).
//
// Persistence (CL-6000): `run` below calls `createWorkflowArtifact`
// (`./artifact-client.ts`) against the sanctioned workflow-artifacts HTTP
// surface — authenticated with the sidecar's own bearer token and this
// run's own mailbox address, both already present on `env`, never a
// database handle. A successful call returns the persisted artifact's
// id/version so the delivery pipeline can reference it with a file part
// (`packages/chat/src/artifact-delivery.ts`); a failed call surfaces as
// an honest `isError: true` result rather than a fabricated success.
//
// This tool exists independently of the spawn-mechanism gap documented
// in `./index.ts`'s header comment: reporting an honest status is not
// blocked on `action`/`invokeAction` landing, only on the model having
// something true to say — so a quiet or disconnected run can still leave
// the sender a real, chip-visible record instead of a bare prose line.

import { type } from "arktype";
import { defineTool, type BaseEnv } from "@intx/agent";
import { createWorkflowArtifact } from "./artifact-client";

export const GRANOLA_CALL_REPORT_STATUS_TOOL_NAME =
  "granola_call_report_status";

export const GRANOLA_CALL_REPORT_STATUS_DESCRIPTION =
  "Persists one honest status artifact for a run that started no " +
  "process-granola-call children: why (no Granola connection, or " +
  "nothing new to process), how many calls were examined, and what to " +
  "check next. Not approval-gated — nothing was selected, so there is " +
  "nothing for a human to confirm.";

const StatusReportArgs = type({
  /** Why this run started nothing, grounded in what actually happened. */
  reason: "string > 0",
  /** How many recent calls this run actually looked at (0 if unreachable). */
  callsExamined: "number >= 0",
  /** Plain-language advice for what the sender should do next. */
  nextSteps: "string > 0",
});

export type StatusReportArgs = typeof StatusReportArgs.infer;

export type ArtifactPayload = {
  title: string;
  kind: "text";
  content: string;
};

/**
 * The payload `createWorkflowArtifact` persists (`{ title, kind,
 * content }`). Every line is drawn from `args` — nothing here is
 * invented sample data.
 */
export function buildStatusArtifactPayload(
  args: StatusReportArgs,
): ArtifactPayload {
  return {
    title: "Granola call notes: nothing new to process",
    kind: "text",
    content:
      "This run started no process-granola-call children.\n\n" +
      `Why\n${args.reason}\n\n` +
      `Calls examined: ${args.callsExamined}\n\n` +
      `Next steps\n${args.nextSteps}\n\n` +
      "Check the granola connector's status for this workspace under " +
      "Settings > Connections.",
  };
}

/**
 * The env this tool needs beyond `BaseEnv`: the sanctioned
 * workflow-artifacts credential trio, populated for every workflow step
 * (`apps/sidecar/src/workflow-substrate-factory/step-env.ts`) — the same
 * three keys `@corbits/artifact-tools`' read-side bundle declares.
 */
export interface WorkflowArtifactEnv extends BaseEnv {
  readonly hubArtifactsUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
}

/**
 * `defineTool`'s env-DI factory shape. Needs the sanctioned
 * workflow-artifacts credential trio beyond `BaseEnv`.
 */
export const GRANOLA_CALL_REPORT_STATUS_TOOL = defineTool<WorkflowArtifactEnv>({
  id: "@corbits/workflow-granola-call/report-status",
  requires: ["hubArtifactsUrl", "sidecarToken", "address"],
  definitions: [{ name: GRANOLA_CALL_REPORT_STATUS_TOOL_NAME }],
  factory: (env) => ({
    definitions: [
      {
        name: GRANOLA_CALL_REPORT_STATUS_TOOL_NAME,
        description: GRANOLA_CALL_REPORT_STATUS_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: {
            reason: { type: "string" },
            callsExamined: { type: "number" },
            nextSteps: { type: "string" },
          },
          required: ["reason", "callsExamined", "nextSteps"],
        },
      },
    ],
    run: async (call) => {
      const parsed = StatusReportArgs(call.arguments);
      if (parsed instanceof type.errors) {
        return {
          callId: call.id,
          isError: true,
          content: `Invalid arguments for ${GRANOLA_CALL_REPORT_STATUS_TOOL_NAME}: ${parsed.summary}`,
        };
      }
      const artifact = buildStatusArtifactPayload(parsed);
      try {
        const created = await createWorkflowArtifact(
          {
            hubArtifactsUrl: env.hubArtifactsUrl,
            sidecarToken: env.sidecarToken,
            runAddress: env.address,
          },
          artifact,
        );
        return {
          callId: call.id,
          isError: false,
          content: JSON.stringify({
            id: created.id,
            version: created.version,
            title: artifact.title,
            kind: artifact.kind,
            persisted: true,
          }),
        };
      } catch (err) {
        return {
          callId: call.id,
          isError: true,
          content: `Failed to persist "${artifact.title}" as a Library artifact: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    },
  }),
});
