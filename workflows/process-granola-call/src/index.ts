// The process-granola-call workflow: the child half of the Granola
// call-notes pipeline (CL-5998). One run processes exactly one Granola
// call: fetch its transcript, save the transcript as a raw artifact,
// extract working notes (participants, summary, pain points, decisions,
// action items), verify them against the transcript, then publish the
// final call-notes artifact. It is spawned by the granola-call parent,
// one run per unprocessed call — never scheduled directly, and never
// exposed as an independent Routine (see this package's `automatable:
// false` in `package.json`'s `corbits.workflow` block, mirrored into
// `@corbits/workflow-catalog`).
//
// This package is installable data. It imports only published platform
// packages, and nothing imports it statically: a host publishes the
// serialized definition as a workflow asset and deploys it through the
// platform's deploy machinery; the execution host materializes it at
// runtime from the deploy alone.
//
// Infrastructure gap (see README "Current limits", and
// `@corbits/granola-call-workflow`'s header comment): nothing in this
// host can spawn this workflow programmatically yet, and Granola access
// itself (`corbitsdev/granola-tools`) is not published anywhere this
// host's tool loader can resolve it from. This definition's single step
// is an honest placeholder until both land — its system prompt commits
// it to saying plainly that it cannot reach Granola or the artifact it
// was asked about, rather than inventing call notes for a transcript it
// never read.

import { defineAgent } from "@intx/agent";
import type { InferencePreference } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";

export const PROCESS_GRANOLA_CALL_WORKFLOW_ID = "wf_process_granola_call";
export const PROCESS_GRANOLA_CALL_STEP_ID = "process-granola-call";

export const PROCESS_GRANOLA_CALL_SYSTEM_PROMPT =
  "You process one Granola call end to end, for the note id this run " +
  "was started with. Fetch its transcript and save it as a raw " +
  "transcript artifact. Read the whole transcript and extract working " +
  "notes with exactly five sections: Participants (names and, when " +
  "stated, roles or companies), Summary (one or two plain paragraphs), " +
  "Pain points, Decisions, and Action items (each a short bullet list " +
  'grounded in the transcript — write "None noted" when the ' +
  "transcript shows none; quote or closely paraphrase, never invent). " +
  "Verify that working document against the transcript, fixing anything " +
  "unsupported or misattributed, then publish the final call-notes " +
  "artifact with the same five sections. " +
  "If you cannot fetch this call's transcript — no Granola connection, " +
  "the note id does not exist, or the transcript is empty — say so " +
  "plainly, in one short sentence, and do not publish a call-notes " +
  "artifact for it. A bad transcript is this one run failing honestly, " +
  "never a fabricated document.";

/**
 * Everything the definition needs that is per-deployment data. The
 * trigger address names a specific deployment's inbox — for this
 * workflow, the address the granola-call parent's spawn mechanism
 * targets once spawning is wired (see README) — so a definition built
 * here is per-deployment by construction.
 */
export interface ProcessGranolaCallWorkflowInput {
  /** The deployment's mail address; each inbound mail is one run. */
  readonly triggerAddress: string;
  /** Provider/model preferences, in order; resolved at deploy time. */
  readonly inferencePreferences: readonly InferencePreference[];
  /** Per-turn timeout in milliseconds, enforced on the single step. */
  readonly turnTimeoutMs: number;
}

/**
 * Builds the process-granola-call definition. Exactly one step, matching
 * the shape every other definition in this repo commits to: tools arrive
 * as packages on the deploy, never inlined here, keeping the definition
 * pure data.
 *
 * The step always sets an explicit `timeout` — the singular `agent:`
 * shorthand sets none, and a wedged inference call would then hang a run
 * forever. A transcript-plus-extraction-plus-verification pass over a
 * long call can run well past a short default, so deployers should give
 * this step more headroom than the shortest steps in the catalog (see
 * README).
 */
export function buildProcessGranolaCallWorkflow(
  input: ProcessGranolaCallWorkflowInput,
): WorkflowDefinition {
  if (input.triggerAddress === "") {
    throw new Error(
      "buildProcessGranolaCallWorkflow requires a non-empty triggerAddress",
    );
  }
  if (!Number.isInteger(input.turnTimeoutMs) || input.turnTimeoutMs <= 0) {
    throw new Error(
      "buildProcessGranolaCallWorkflow requires turnTimeoutMs to be a positive integer",
    );
  }
  return defineWorkflow({
    id: PROCESS_GRANOLA_CALL_WORKFLOW_ID,
    trigger: { type: "mail", to: input.triggerAddress },
    steps: {
      [PROCESS_GRANOLA_CALL_STEP_ID]: step({
        agent: defineAgent({
          id: PROCESS_GRANOLA_CALL_STEP_ID,
          description:
            "Processes one Granola call into a verified, published " +
            "call-notes artifact",
          systemPrompt: PROCESS_GRANOLA_CALL_SYSTEM_PROMPT,
          tools: [],
          capabilities: [],
          inference: { sources: input.inferencePreferences },
        }),
        timeout: input.turnTimeoutMs,
      }),
    },
  });
}

/**
 * Serializes a definition to the JSON a workflow asset carries. The
 * definition must survive the asset round-trip byte-faithfully, so
 * anything JSON would silently drop or mangle — functions, undefined,
 * symbols, bigints, non-finite numbers, class instances — is a loud
 * error naming the offending path instead of a corrupted asset.
 */
export function serializeProcessGranolaCallWorkflow(
  definition: WorkflowDefinition,
): string {
  assertJsonPortable(definition, "definition");
  return JSON.stringify(definition);
}

function assertJsonPortable(value: unknown, path: string): void {
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`${path} is a non-finite number; JSON drops it`);
      }
      return;
    case "object":
      break;
    default:
      throw new Error(
        `${path} is a ${typeof value}, which does not survive JSON ` +
          "serialization",
      );
  }
  if (Array.isArray(value)) {
    value.forEach((element, index) => {
      assertJsonPortable(element, `${path}[${index}]`);
    });
    return;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(
      `${path} is a non-plain object; JSON would flatten it lossily`,
    );
  }
  for (const [key, entry] of Object.entries(value)) {
    assertJsonPortable(entry, `${path}.${key}`);
  }
}
