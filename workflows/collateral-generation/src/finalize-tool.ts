// The one piece of this workflow gated by human approval: finalizing the
// full set of pieces the human approved during swipe review. Kept inside
// the workflow package rather than a shared tool package — same
// "workflow-specific logic lives in the definition" convention
// `pain-point-collateral`'s `finalize-tool.ts` established — this is not
// a reusable integration on its own.
//
// Gate consolidation (CL-5996): the OG `gtm-workbench` implementation
// suspended for a human four times in sequence — source pick, content-type
// pick, a swipe review per drafted piece, and a second review of anything
// regenerated. Three of those are ordinary conversational turns (asking
// what to draft from, what to draft, and swiping good/bad/regenerate on
// each draft, with at most one revise pass), not approval-gate suspends —
// they only looked like gates because the OG's step-graph architecture had
// no other way to pause for input. This port asks the same questions in
// the same conversation instead (see `./index.ts`'s system prompt) and
// keeps exactly one real approval gate: finalizing the pieces the human
// actually approved, all at once, as one call to this tool.
//
// Approval mechanics: identical to `pain-point-collateral`'s
// `finalize-tool.ts` — `definitions` marks this tool's one definition
// `approval: "ask"`, the platform's native tool-approval gate. Calling it
// suspends the run and creates a real `approval` row; only executes once a
// human approves it. See that file's header comment for the full
// suspend/resume account, which applies unchanged here.
//
// Known platform gap (same as pain-point-collateral, tracked as CL-6000):
// no workflow tool package in this repo can reach the hub's database or
// its authenticated HTTP API today, so `run` below cannot call
// `@corbits/artifacts`' `artifact_create` and persist a Library row per
// piece yet. It builds the exact payload each call needs and returns them,
// `persisted: false`, so wiring the real calls in is a one-line loop the
// moment that path lands, not a redesign.

import { type } from "arktype";
import { defineTool } from "@intx/agent";

export const COLLATERAL_GENERATION_FINALIZE_TOOL_NAME =
  "collateral_generation_finalize";

export const COLLATERAL_GENERATION_FINALIZE_DESCRIPTION =
  "Finalizes the full set of human-approved collateral pieces from one run, pending a single human approval, and prepares each as a Library artifact.";

const CollateralPiece = type({
  /** Short, human-facing title. */
  title: "string > 0",
  /** One of the content-type ids named in the system prompt, e.g. "linkedin-post". */
  contentType: "string > 0",
  /** The drafted (and, if regenerated once, revised) piece body. */
  content: "string > 0",
});

const FinalizeArgs = type({
  pieces: CollateralPiece.array(),
});

export type FinalizeArgs = typeof FinalizeArgs.infer;
export type CollateralPiece = typeof CollateralPiece.infer;

export type ArtifactPayload = {
  title: string;
  kind: string;
  content: string;
};

/**
 * The payload `@corbits/artifacts`' `artifact_create` tool expects
 * (`{ title, kind, content }`) for one piece — `kind` carries the
 * content-type id, matching the OG's convention of using the content
 * type as the artifact's kind.
 */
export function buildArtifactPayloads(
  args: FinalizeArgs,
): readonly ArtifactPayload[] {
  return args.pieces.map((piece) => ({
    title: piece.title,
    kind: piece.contentType,
    content: piece.content,
  }));
}

/**
 * `defineTool`'s env-DI factory shape. This tool needs nothing beyond
 * `BaseEnv`, so `requires` is empty.
 */
export const COLLATERAL_GENERATION_FINALIZE_TOOL = defineTool({
  id: "@corbits/workflow-collateral-generation/finalize",
  requires: [],
  definitions: [
    {
      name: COLLATERAL_GENERATION_FINALIZE_TOOL_NAME,
      approval: "ask",
    },
  ],
  factory: () => ({
    definitions: [
      {
        name: COLLATERAL_GENERATION_FINALIZE_TOOL_NAME,
        description: COLLATERAL_GENERATION_FINALIZE_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: {
            pieces: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  contentType: { type: "string" },
                  content: { type: "string" },
                },
                required: ["title", "contentType", "content"],
              },
            },
          },
          required: ["pieces"],
        },
      },
    ],
    run: async (call) => {
      const parsed = FinalizeArgs(call.arguments);
      if (parsed instanceof type.errors) {
        return {
          callId: call.id,
          isError: true,
          content: `Invalid arguments for ${COLLATERAL_GENERATION_FINALIZE_TOOL_NAME}: ${parsed.summary}`,
        };
      }
      if (parsed.pieces.length === 0) {
        return {
          callId: call.id,
          isError: true,
          content: `${COLLATERAL_GENERATION_FINALIZE_TOOL_NAME} requires at least one approved piece`,
        };
      }
      const artifacts = buildArtifactPayloads(parsed);
      return {
        callId: call.id,
        isError: false,
        content: JSON.stringify({
          artifacts: artifacts.map((artifact) => ({
            title: artifact.title,
            content: artifact.content,
            persisted: false,
            persistedReason:
              "workflow tool packages cannot reach the Library engine yet; see this file's header comment",
          })),
        }),
      };
    },
  }),
});
