// The one piece of this workflow gated by human approval: finalizing a
// drafted collateral piece. Kept inside the workflow package rather than
// a shared tool package — this behavior (what "finalize" means for a
// pain-point-collateral run) is specific to this workflow, not a
// reusable integration, so it stays folded into the definition per the
// workflow-catalog's "workflow-specific logic lives in the definition"
// convention (only genuinely reusable integrations, like
// `@corbits/tools-granola`, live outside it).
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
// approver"), which this workflow's system prompt (see `prompts.ts`)
// turns into a calm, plain terminal reply rather than an error.
//
// Known platform gap (read before wiring this into a live deploy): no
// workflow tool package in this repo can reach the hub's database or
// its authenticated HTTP API today — tool packages are materialized
// into the sidecar's workflow-process child, a separate process with no
// DB handle and no hub-service credential path (confirmed while porting
// this workflow; the same category of gap CL-5998's
// `@corbits/granola-call-workflow` README documents for its own missing
// spawn-child and tool-pin capabilities). So `run` below cannot actually
// call `@corbits/artifacts`' `artifact_create` and persist a Library
// row yet. It builds the exact payload that call needs
// (`buildArtifactPayload`) and returns it, `persisted: false`, so the
// moment that service-credential path lands, wiring the real call in is
// a one-line change here, not a redesign.

import { type } from "arktype";
import { defineTool } from "@intx/agent";

export const PAIN_POINT_COLLATERAL_FINALIZE_TOOL_NAME =
  "pain_point_collateral_finalize";

export const PAIN_POINT_COLLATERAL_FINALIZE_DESCRIPTION =
  "Finalizes one piece of pain-point sales collateral, pending human approval, and prepares it as a Library artifact.";

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
 * The payload `@corbits/artifacts`' `artifact_create` tool expects
 * (`{ title, kind, content }`). Built here so the eventual real call is
 * a straight pass-through of this object, not a payload assembled at
 * the call site.
 */
export function buildArtifactPayload(args: FinalizeArgs): ArtifactPayload {
  return {
    title: args.title,
    kind: "text",
    content: `Targets: ${args.painPoint}\n\n${args.content}`,
  };
}

/**
 * `defineTool`'s env-DI factory shape. This tool needs nothing beyond
 * `BaseEnv`, so `requires` is empty.
 */
export const PAIN_POINT_COLLATERAL_FINALIZE_TOOL = defineTool({
  id: "@corbits/workflow-pain-point-collateral/finalize",
  requires: [],
  definitions: [
    {
      name: PAIN_POINT_COLLATERAL_FINALIZE_TOOL_NAME,
      approval: "ask",
    },
  ],
  factory: () => ({
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
      return {
        callId: call.id,
        isError: false,
        content: JSON.stringify({
          title: artifact.title,
          content: artifact.content,
          persisted: false,
          persistedReason:
            "workflow tool packages cannot reach the Library engine yet; see this file's header comment",
        }),
      };
    },
  }),
});
