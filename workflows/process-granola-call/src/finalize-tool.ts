// The one piece of this workflow gated by human approval: finalizing one
// call's outcome, either the verified call-notes artifact or — when the
// transcript could not be fetched — a teaching artifact explaining what
// was attempted and what to check next. Kept inside the workflow package
// rather than a shared tool package — this behavior (what "finalize"
// means for a process-granola-call run) is specific to this workflow, not
// a reusable integration, so it stays folded into the definition per the
// workflow-catalog's "workflow-specific logic lives in the definition"
// convention.
//
// Approval mechanics: `defineTool`'s `definitions` array marks this
// tool's one definition `approval: "ask"` (see
// `@intx/agent/src/tool.ts`'s `ToolDeclaration`/`toolApprovalEffect`),
// the platform's native gate — see `workflows/pain-point-collateral/src/finalize-tool.ts`'s
// header comment for the full suspend/resume path, identical here.
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
// Two shapes, one tool: a real call gets a five-section call-notes
// artifact (`status: "notes"`); a call whose transcript could not be
// fetched gets a teaching artifact instead of a bare "nothing to
// report" reply (`status: "no-data"`) — what call was attempted, why it
// came up empty, and what to check next (the `granola` connector from
// `packages/connections/src/registry.ts`). Both are real persisted,
// chip-visible Library artifacts; neither invents call content.

import { type } from "arktype";
import { defineTool, type BaseEnv } from "@intx/agent";
import { createWorkflowArtifact } from "./artifact-client";

export const PROCESS_GRANOLA_CALL_FINALIZE_TOOL_NAME =
  "process_granola_call_finalize";

export const PROCESS_GRANOLA_CALL_FINALIZE_DESCRIPTION =
  "Finalizes one Granola call, pending human approval, and persists the " +
  "outcome as a Library artifact — a five-section call-notes artifact " +
  "when the transcript was read, or a teaching artifact explaining what " +
  "went wrong when it could not be fetched.";

const NotesFinalizeArgs = type({
  status: "'notes'",
  /** The Granola call id this run was started with. */
  callId: "string > 0",
  /** Short, human-facing title. Doubles as the inbox/approve-card headline. */
  title: "string > 0",
  participants: "string > 0",
  summary: "string > 0",
  painPoints: "string > 0",
  decisions: "string > 0",
  actionItems: "string > 0",
});

const NoDataFinalizeArgs = type({
  status: "'no-data'",
  /** The Granola call id this run was started with. */
  callId: "string > 0",
  /** Short, human-facing title. Doubles as the inbox/approve-card headline. */
  title: "string > 0",
  /** Why the transcript could not be fetched, grounded in what actually happened. */
  reason: "string > 0",
  /** What a human should check next (e.g. the granola connector's status). */
  nextSteps: "string > 0",
});

const FinalizeArgs = NotesFinalizeArgs.or(NoDataFinalizeArgs);

export type FinalizeArgs = typeof FinalizeArgs.infer;

export type ArtifactPayload = {
  title: string;
  kind: "text" | "status-note";
  content: string;
};

/**
 * The payload `createWorkflowArtifact` persists (`{ title, kind,
 * content }`). Built here so the persist call is a straight pass-through
 * of this object, not a payload assembled at the call site. `kind`
 * comes from `args.status` — the same structural discriminator that
 * already picks which of the two content shapes to build — never from
 * free-text the model could drift on.
 */
export function buildArtifactPayload(args: FinalizeArgs): ArtifactPayload {
  if (args.status === "notes") {
    return {
      title: args.title,
      kind: "text",
      content:
        `Call: ${args.callId}\n\n` +
        `Participants\n${args.participants}\n\n` +
        `Summary\n${args.summary}\n\n` +
        `Pain points\n${args.painPoints}\n\n` +
        `Decisions\n${args.decisions}\n\n` +
        `Action items\n${args.actionItems}`,
    };
  }
  return {
    title: args.title,
    kind: "status-note",
    content:
      `Call: ${args.callId}\n\n` +
      "This call could not be processed.\n\n" +
      `Why\n${args.reason}\n\n` +
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
export const PROCESS_GRANOLA_CALL_FINALIZE_TOOL =
  defineTool<WorkflowArtifactEnv>({
    id: "@corbits/workflow-process-granola-call/finalize",
    requires: ["hubArtifactsUrl", "sidecarToken", "address"],
    definitions: [
      {
        name: PROCESS_GRANOLA_CALL_FINALIZE_TOOL_NAME,
        approval: "ask",
      },
    ],
    factory: (env) => ({
      definitions: [
        {
          name: PROCESS_GRANOLA_CALL_FINALIZE_TOOL_NAME,
          description: PROCESS_GRANOLA_CALL_FINALIZE_DESCRIPTION,
          inputSchema: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["notes", "no-data"] },
              callId: { type: "string" },
              title: { type: "string" },
              participants: { type: "string" },
              summary: { type: "string" },
              painPoints: { type: "string" },
              decisions: { type: "string" },
              actionItems: { type: "string" },
              reason: { type: "string" },
              nextSteps: { type: "string" },
            },
            required: ["status", "callId", "title"],
          },
        },
      ],
      run: async (call) => {
        const parsed = FinalizeArgs(call.arguments);
        if (parsed instanceof type.errors) {
          return {
            callId: call.id,
            isError: true,
            content: `Invalid arguments for ${PROCESS_GRANOLA_CALL_FINALIZE_TOOL_NAME}: ${parsed.summary}`,
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
