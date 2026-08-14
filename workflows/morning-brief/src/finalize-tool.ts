// The one piece of this workflow gated by human approval: finalizing the
// day's brief. Kept inside the workflow package rather than a shared tool
// package — same "workflow-specific logic lives in the definition"
// convention `pain-point-collateral`'s `finalize-tool.ts` established —
// this is not a reusable integration on its own.
//
// Approval mechanics: identical to `pain-point-collateral`'s
// `finalize-tool.ts` — `definitions` marks this tool's one definition
// `approval: "ask"`, the platform's native tool-approval gate. Calling it
// suspends the run and creates a real `approval` row; only executes once
// a human approves it. See that file's header comment for the full
// suspend/resume account, which applies unchanged here.
//
// Persistence: `run` below calls `createWorkflowArtifact`
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
//
// The finalized content is not always a "real" brief: on the no-data
// path (every source not connected or empty) this workflow's system
// prompt (see `./index.ts`) still calls this same tool with a teaching
// payload — what the brief would have looked for and which connectors
// are missing — so a run always ends in a persisted, chip-visible
// artifact rather than silence.

import { type } from "arktype";
import { defineTool, type BaseEnv } from "@intx/agent";
import { createWorkflowArtifact } from "./artifact-client";

export const MORNING_BRIEF_FINALIZE_TOOL_NAME = "morning_brief_finalize";

export const MORNING_BRIEF_FINALIZE_DESCRIPTION =
  "Finalizes the daily brief, pending human approval, and persists it as a Library artifact.";

const FinalizeArgs = type({
  /** Short, human-facing title. Doubles as the inbox/approve-card headline. */
  title: "string > 0",
  /** The finished brief's markdown body — a real brief, or an honest teaching payload on the no-data path. */
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
    content: args.content,
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
export const MORNING_BRIEF_FINALIZE_TOOL = defineTool<WorkflowArtifactEnv>({
  id: "@corbits/workflow-morning-brief/finalize",
  requires: ["hubArtifactsUrl", "sidecarToken", "address"],
  definitions: [
    {
      name: MORNING_BRIEF_FINALIZE_TOOL_NAME,
      approval: "ask",
    },
  ],
  factory: (env) => ({
    definitions: [
      {
        name: MORNING_BRIEF_FINALIZE_TOOL_NAME,
        description: MORNING_BRIEF_FINALIZE_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            content: { type: "string" },
          },
          required: ["title", "content"],
        },
      },
    ],
    run: async (call) => {
      const parsed = FinalizeArgs(call.arguments);
      if (parsed instanceof type.errors) {
        return {
          callId: call.id,
          isError: true,
          content: `Invalid arguments for ${MORNING_BRIEF_FINALIZE_TOOL_NAME}: ${parsed.summary}`,
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
