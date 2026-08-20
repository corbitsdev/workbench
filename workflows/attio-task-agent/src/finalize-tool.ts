// The one piece of this workflow's *own* surface gated by human
// approval: saving a finished draft to the Library. The other gate —
// writing back to the CRM — is `@corbits/mcp-tools`' `mcp_call`, which
// is `approval: "ask"` unconditionally; this workflow never re-implements
// it (see `./index.ts`'s header comment).
//
// Approval mechanics: `definitions` marks this tool's one definition
// `approval: "ask"`, the platform's native tool-approval gate. Calling it
// suspends the run and creates a real `approval` row; `run` below only
// executes once a human approves. See `pain-point-collateral`'s
// `finalize-tool.ts` for the full suspend/resume account, which applies
// unchanged here.
//
// Persistence: `run` calls `createWorkflowArtifact` (`./artifact-client.ts`,
// duplicated from `@corbits/artifact-tools`' client rather than imported —
// see that file's header for why this installable-data package never
// imports another `@corbits/*` package) against the sanctioned
// workflow-artifacts HTTP surface.

import { type } from "arktype";
import { defineTool, type BaseEnv } from "@intx/agent";
import { createWorkflowArtifact } from "./artifact-client";
import { ATTIO_TASK_ARTIFACT_KINDS } from "./prompts";

export const ATTIO_TASK_AGENT_FINALIZE_TOOL_NAME = "attio_task_agent_finalize";

export const ATTIO_TASK_AGENT_FINALIZE_DESCRIPTION =
  "Saves one finished draft for this CRM task, pending human approval, and persists it as a Library artifact.";

/**
 * The draft kinds this tool accepts, as an arktype union. Built from the
 * one exported list so the prompt's menu and the parser's accepted set
 * cannot drift — a kind the guidance never taught is rejected here rather
 * than silently persisted under a label nothing recognizes.
 */
const DraftKind = type.enumerated(...ATTIO_TASK_ARTIFACT_KINDS);

const FinalizeArgs = type({
  /**
   * Which of the two shapes this call is: `"draft"` for a finished piece;
   * `"status-note"` for a task that genuinely needed no drafting. This
   * fixes the persisted artifact's `kind` — the model names the outcome,
   * never the storage kind, so a run cannot mislabel a note as real work.
   */
  outcome: "'draft'|'status-note'",
  /** Short, human-facing title. Doubles as the approve-card headline. */
  title: "string > 0",
  /** Which kind of piece this is — one of the kinds the prompt teaches. */
  draftKind: DraftKind,
  /** The finished body, or the status note's honest explanation. */
  content: "string > 0",
});

export type FinalizeArgs = typeof FinalizeArgs.infer;

export type ArtifactPayload = {
  title: string;
  kind: "text" | "status-note";
  content: string;
};

/**
 * The payload `createWorkflowArtifact` persists. The draft kind leads the
 * body rather than becoming the storage `kind`: the Library's kinds are
 * `text` / `status-note`, and losing "this is a cold email" would leave a
 * reader guessing what they are looking at.
 */
export function buildArtifactPayload(args: FinalizeArgs): ArtifactPayload {
  if (args.outcome === "status-note") {
    return { title: args.title, kind: "status-note", content: args.content };
  }
  return {
    title: args.title,
    kind: "text",
    content: `Kind: ${args.draftKind}\n\n${args.content}`,
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

export const ATTIO_TASK_AGENT_FINALIZE_TOOL = defineTool<WorkflowArtifactEnv>({
  id: "@corbits/workflow-attio-task-agent/finalize",
  requires: ["hubArtifactsUrl", "sidecarToken", "address"],
  definitions: [
    {
      name: ATTIO_TASK_AGENT_FINALIZE_TOOL_NAME,
      approval: "ask",
    },
  ],
  factory: (env) => ({
    definitions: [
      {
        name: ATTIO_TASK_AGENT_FINALIZE_TOOL_NAME,
        description: ATTIO_TASK_AGENT_FINALIZE_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: {
            outcome: { type: "string", enum: ["draft", "status-note"] },
            title: { type: "string" },
            draftKind: { type: "string", enum: [...ATTIO_TASK_ARTIFACT_KINDS] },
            content: { type: "string" },
          },
          required: ["outcome", "title", "draftKind", "content"],
        },
      },
    ],
    run: async (call) => {
      const parsed = FinalizeArgs(call.arguments);
      if (parsed instanceof type.errors) {
        return {
          callId: call.id,
          isError: true,
          content: `Invalid arguments for ${ATTIO_TASK_AGENT_FINALIZE_TOOL_NAME}: ${parsed.summary}`,
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
          content: `Failed to save "${artifact.title}" to the Library: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    },
  }),
});
