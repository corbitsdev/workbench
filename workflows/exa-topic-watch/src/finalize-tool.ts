// The one piece of this workflow gated by human approval: publishing the
// digest. Kept inside the workflow package rather than a shared tool
// package — same "workflow-specific logic lives in the definition"
// convention `pain-point-collateral`'s `finalize-tool.ts` established —
// this is not a reusable integration on its own.
//
// Approval mechanics: identical to `last-30-days-research`'s
// `finalize-tool.ts` — `definitions` marks this tool's one definition
// `approval: "ask"`, the platform's native tool-approval gate. Calling it
// suspends the run and creates a real `approval` row; only executes once
// a human approves it. See `pain-point-collateral`'s `finalize-tool.ts`
// for the full suspend/resume account, which applies unchanged here.
//
// Persistence: `run` below calls `createWorkflowArtifact`
// (`./artifact-client.ts`, duplicated from `@corbits/artifact-tools`'
// client rather than imported — see that file's header for why this
// installable-data package never imports another `@corbits/*` package)
// against the sanctioned workflow-artifacts HTTP surface.
//
// This watch runs unattended on a schedule, so a quiet week is the
// common case, not an error. `outcome: "status-note"` is that path: the
// run still finalizes, with an honest "nothing new on this topic since
// the last run" payload, so every fire leaves a visible trace instead of
// silence.

import { type } from "arktype";
import { defineTool, type BaseEnv } from "@intx/agent";
import { createWorkflowArtifact } from "./artifact-client";

export const EXA_TOPIC_WATCH_FINALIZE_TOOL_NAME = "exa_topic_watch_finalize";

export const EXA_TOPIC_WATCH_FINALIZE_DESCRIPTION =
  "Publishes this run's topic digest, pending human approval, and persists it as a Library artifact.";

const FinalizeArgs = type({
  /**
   * Which of the two shapes this call is: `"digest"` when the watch
   * found something worth reading; `"status-note"` for the quiet-run
   * path. This is what fixes the persisted artifact's `kind` — the model
   * names the outcome, but never supplies `kind` directly, so a run can
   * never mislabel a quiet run as a real digest or vice versa.
   */
  outcome: "'digest'|'status-note'",
  /** Short, human-facing title. Doubles as the inbox/approve-card headline. */
  title: "string > 0",
  /** The digest's markdown body, or the quiet-run note's honest explanation. */
  content: "string > 0",
});

export type FinalizeArgs = typeof FinalizeArgs.infer;

export type ArtifactPayload = {
  title: string;
  kind: "text" | "status-note";
  content: string;
};

/**
 * The payload `createWorkflowArtifact` persists (`{ title, kind,
 * content }`). Built here so the persist call is a straight pass-through
 * of this object, not a payload assembled at the call site. `kind` comes
 * from `args.outcome`, never from free-text the model could drift on.
 */
export function buildArtifactPayload(args: FinalizeArgs): ArtifactPayload {
  return {
    title: args.title,
    kind: args.outcome === "status-note" ? "status-note" : "text",
    content: args.content,
  };
}

/**
 * The env this tool needs beyond `BaseEnv`: the sanctioned
 * workflow-artifacts credential trio, populated for every workflow step
 * (`apps/sidecar/src/workflow-substrate-factory/step-env.ts`).
 */
export interface WorkflowArtifactEnv extends BaseEnv {
  readonly hubArtifactsUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
}

export const EXA_TOPIC_WATCH_FINALIZE_TOOL = defineTool<WorkflowArtifactEnv>({
  id: "@corbits/workflow-exa-topic-watch/finalize",
  requires: ["hubArtifactsUrl", "sidecarToken", "address"],
  definitions: [
    {
      name: EXA_TOPIC_WATCH_FINALIZE_TOOL_NAME,
      approval: "ask",
    },
  ],
  factory: (env) => ({
    definitions: [
      {
        name: EXA_TOPIC_WATCH_FINALIZE_TOOL_NAME,
        description: EXA_TOPIC_WATCH_FINALIZE_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: {
            outcome: { type: "string", enum: ["digest", "status-note"] },
            title: { type: "string" },
            content: { type: "string" },
          },
          required: ["outcome", "title", "content"],
        },
      },
    ],
    run: async (call) => {
      const parsed = FinalizeArgs(call.arguments);
      if (parsed instanceof type.errors) {
        return {
          callId: call.id,
          isError: true,
          content: `Invalid arguments for ${EXA_TOPIC_WATCH_FINALIZE_TOOL_NAME}: ${parsed.summary}`,
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
          content: `Failed to publish "${artifact.title}" to the Library: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    },
  }),
});
