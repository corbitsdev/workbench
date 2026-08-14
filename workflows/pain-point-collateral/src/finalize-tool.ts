// The one piece of this workflow gated by human approval: finalizing a
// drafted collateral piece. Kept inside the workflow package rather than
// a shared tool package — this behavior (what "finalize" means for a
// pain-point-collateral run) is specific to this workflow, not a
// reusable integration, so it stays folded into the definition per the
// workflow-catalog's "workflow-specific logic lives in the definition"
// convention (only genuinely reusable integrations, like
// `@corbits/granola-tools`, live outside it).
//
// Approval mechanics: `defineTool`'s `definitions` array marks this
// tool's one definition `approval: "ask"` (see
// `vendor/intx/agent/src/tool.ts`'s `ToolDeclaration`/`toolApprovalEffect`),
// the platform's native gate. When the model calls this tool, the
// authz extension floors the call's grant at `"ask"` and suspends the
// run instead of invoking `run` below — the sidecar co-writes an
// `approval` row (visible in the inbox via `@corbits/approvals`) and the
// run parks until a human approves or rejects it
// (`vendor/intx/inference/src/reactor.ts`'s `resolveApprovalDecision`).
// On approval the parked call is re-dispatched and `run` below executes
// for real, exactly once. On rejection `run` never executes at all — the
// model instead sees a synthetic `isError: true` result ("denied by
// approver"), which this workflow's system prompt (see `./index.ts`'s
// `PAIN_POINT_COLLATERAL_SYSTEM_PROMPT`) turns into a calm, plain
// terminal reply rather than an error.
//
// Persistence (CL-6000): `run` below calls `createWorkflowArtifact`
// (`./artifact-client.ts`, duplicated from `@corbits/artifact-tools`'
// client rather than imported — see that file's header for why this
// installable-data package never imports another `@corbits/*` package)
// against the sanctioned workflow-artifacts HTTP surface — authenticated
// with the sidecar's own bearer token and this run's own mailbox
// address, both already present on `env`, never a database handle. A
// successful call returns the persisted artifact's id/version so the
// delivery pipeline can reference it with a file part
// (`packages/chat/src/artifact-delivery.ts`); a failed call surfaces as
// an honest `isError: true` result rather than a fabricated success.

import { type } from "arktype";
import { defineTool, type BaseEnv } from "@intx/agent";
import { createWorkflowArtifact } from "./artifact-client";

export const PAIN_POINT_COLLATERAL_FINALIZE_TOOL_NAME =
  "pain_point_collateral_finalize";

export const PAIN_POINT_COLLATERAL_FINALIZE_DESCRIPTION =
  "Finalizes one piece of pain-point sales collateral, pending human approval, and persists it as a Library artifact.";

const FinalizeArgs = type({
  /** Short, human-facing title. Doubles as the inbox/approve-card headline. */
  title: "string > 0",
  /** The customer pain point this piece targets, verbatim from the transcript. */
  painPoint: "string > 0",
  /** The drafted collateral body. */
  content: "string > 0",
});

export type FinalizeArgs = typeof FinalizeArgs.infer;

export type ArtifactPayload = {
  title: string;
  kind: "text";
  content: string;
};

/**
 * The payload `createWorkflowArtifact` persists (`{ title, kind,
 * content }`). Built here so the persist call is a straight pass-through
 * of this object, not a payload assembled at the call site.
 */
export function buildArtifactPayload(args: FinalizeArgs): ArtifactPayload {
  return {
    title: args.title,
    kind: "text",
    content: `Targets: ${args.painPoint}\n\n${args.content}`,
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
export const PAIN_POINT_COLLATERAL_FINALIZE_TOOL = defineTool<WorkflowArtifactEnv>({
  id: "@corbits/workflow-pain-point-collateral/finalize",
  requires: ["hubArtifactsUrl", "sidecarToken", "address"],
  definitions: [
    {
      name: PAIN_POINT_COLLATERAL_FINALIZE_TOOL_NAME,
      approval: "ask",
    },
  ],
  factory: (env) => ({
    definitions: [
      {
        name: PAIN_POINT_COLLATERAL_FINALIZE_TOOL_NAME,
        description: PAIN_POINT_COLLATERAL_FINALIZE_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            painPoint: { type: "string" },
            content: { type: "string" },
          },
          required: ["title", "painPoint", "content"],
        },
      },
    ],
    run: async (call) => {
      const parsed = FinalizeArgs(call.arguments);
      if (parsed instanceof type.errors) {
        return {
          callId: call.id,
          isError: true,
          content: `Invalid arguments for ${PAIN_POINT_COLLATERAL_FINALIZE_TOOL_NAME}: ${parsed.summary}`,
        };
      }
      const artifact = buildArtifactPayload(parsed);
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
