// The trust boundary for this workflow's trigger-carried input. The
// trigger is mail: the run's entire raw input is whatever text and
// fields a sender's mail body carries, read by the model itself (there
// is no server-side code between the trigger and the agent — see
// `./index.ts`'s header for why this definition is pure prompt-driven
// data). Two fields are named and load-bearing: `transcript` (a pasted
// call transcript) and `noteId` (a Granola note id). Rather than let the
// model treat that raw trigger content as unexamined free-form JSON, the
// system prompt (`./index.ts`'s `PAIN_POINT_COLLATERAL_SYSTEM_PROMPT`)
// requires calling this tool first, passing along whichever of the two
// named fields it found — `run` below is the one place both fields are
// actually parsed against a schema, honestly rejecting anything that
// does not match rather than passing raw unknown JSON further into the
// run.
//
// No approval gate: unlike `./finalize-tool.ts`, this tool has no
// external side effect — it only validates and normalizes intake — so
// it carries no `approval` declaration.

import { type } from "arktype";
import { defineTool, type BaseEnv } from "@intx/agent";

export const PAIN_POINT_COLLATERAL_INTAKE_TOOL_NAME =
  "pain_point_collateral_intake";

export const PAIN_POINT_COLLATERAL_INTAKE_DESCRIPTION =
  "Validates and normalizes the trigger's named intake fields (a pasted transcript or a Granola note id), reporting which one, if either, was actually given.";

const IntakeArgs = type({
  /** A pasted call transcript, verbatim from the trigger, if given. */
  "transcript?": "string",
  /** A Granola note id, verbatim from the trigger, if given. */
  "noteId?": "string",
  "+": "reject",
});

export type IntakeArgs = typeof IntakeArgs.infer;

export type IntakeResult =
  | { readonly source: "transcript"; readonly transcript: string }
  | { readonly source: "noteId"; readonly noteId: string }
  | { readonly source: "none" };

/**
 * A blank or whitespace-only string counts the same as an absent field:
 * neither names real intake content.
 */
function normalized(value: string | undefined): string {
  return (value ?? "").trim();
}

/**
 * Resolves which named field, if either, carries real intake content.
 * `transcript` wins when both are given — it needs no further fetch.
 */
export function resolveIntake(args: IntakeArgs): IntakeResult {
  const transcript = normalized(args.transcript);
  if (transcript !== "") {
    return { source: "transcript", transcript };
  }
  const noteId = normalized(args.noteId);
  if (noteId !== "") {
    return { source: "noteId", noteId };
  }
  return { source: "none" };
}

/** `defineTool`'s env-DI factory shape. No env needs beyond `BaseEnv`. */
export const PAIN_POINT_COLLATERAL_INTAKE_TOOL = defineTool<BaseEnv>({
  id: "@corbits/workflow-pain-point-collateral/intake",
  requires: [],
  definitions: [{ name: PAIN_POINT_COLLATERAL_INTAKE_TOOL_NAME }],
  factory: () => ({
    definitions: [
      {
        name: PAIN_POINT_COLLATERAL_INTAKE_TOOL_NAME,
        description: PAIN_POINT_COLLATERAL_INTAKE_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: {
            transcript: { type: "string" },
            noteId: { type: "string" },
          },
        },
      },
    ],
    run: async (call) => {
      const parsed = IntakeArgs(call.arguments);
      if (parsed instanceof type.errors) {
        return {
          callId: call.id,
          isError: true,
          content: `Invalid trigger input for ${PAIN_POINT_COLLATERAL_INTAKE_TOOL_NAME}: ${parsed.summary}`,
        };
      }
      return {
        callId: call.id,
        isError: false,
        content: JSON.stringify(resolveIntake(parsed)),
      };
    },
  }),
});
