// The pain-point-collateral workflow (CL-5995, ported from
// `gtm-workbench`'s `workflows/pain-point-collateral`): turns one sales
// call transcript into one piece of targeted collateral, gated behind a
// single human approval before anything is finalized.
//
// One step, one agent — matching the shape every other definition in
// this catalog commits to (`step`/`defineAgent`, mail-triggered, tools
// arrive as packages on the deploy, never inlined here). All
// pipeline-specific logic — how intake resolves a transcript, what
// counts as extracted pain points, how a draft gets finalized, the
// exact wording of an honest "no transcript"/"not approved" reply —
// lives in this definition's own system prompt and its one
// workflow-local tool (`./finalize-tool.ts`), not a separate tool
// package: none of it is a reusable integration on its own. The one
// genuinely reusable piece, fetching a Granola note by id, is
// `granola_get_note` from `@corbits/granola-tools` — the same package
// the morning-brief workflow (CL-5993) pins for its own
// `granola_list_recent_notes` call; both tools share that one bundle
// rather than forking a second Granola client.
//
// Approval mechanics: see `finalize-tool.ts`'s header comment for the
// exact suspend/resume path. In short — `pain_point_collateral_finalize`
// is declared `approval: "ask"`, the platform's native tool-approval
// gate, so calling it suspends the run, creates a real `approval` row
// (visible in the inbox via `@corbits/approvals`), and only executes
// once a human approves it.
//
// Tool-package pins (CL-5999): `@intx/agent`'s `defineAgent` still does
// not accept a `toolPackagePins` field on its authoring-time config —
// it is vendored, read-only source for this change — so the agent
// below is built directly against `AgentDefinition`'s own type, which
// already carries the field. `@corbits/granola-tools` is pinned below
// for `granola_get_note`; whether the pin *resolves* at deploy time
// still depends on an operator publishing it to a registry the host's
// tool-package resolver can reach (see `apps/hub/src/index.ts`'s
// `toolPackageRegistries` wiring). See `finalize-tool.ts`'s header for
// the separate, still-open gap around this workflow's local finalize
// tool. Until a deploy actually resolves the pin, this definition's
// system prompt still commits it to saying plainly when it has no way
// to reach Granola or finalize a piece, rather than inventing a
// transcript, pain points, or an approval that never happened.
//
// This package is installable data. It imports only published platform
// packages, and nothing imports it statically: a host publishes the
// serialized definition as a workflow asset and deploys it through the
// platform's deploy machinery; the execution host materializes it at
// runtime from the deploy alone.

import type { AgentDefinition, InferencePreference } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";
import type { ToolPackagePin } from "@intx/types/tool-packages";

import { PAIN_POINT_COLLATERAL_FINALIZE_TOOL_NAME } from "./finalize-tool";

export const PAIN_POINT_COLLATERAL_WORKFLOW_ID = "wf_pain_point_collateral";
export const PAIN_POINT_COLLATERAL_STEP_ID = "pain-point-collateral";

export const PAIN_POINT_COLLATERAL_SYSTEM_PROMPT =
  "You turn one sales call transcript into one piece of collateral " +
  "targeted at a customer's real pain points, with a mandatory human " +
  "approval step before anything is finalized.\n\n" +
  "Intake: the trigger carries either a pasted transcript (`transcript`) " +
  "or a Granola note id (`noteId`). If `transcript` is given, use it " +
  "verbatim. Otherwise, if `noteId` is given, fetch that note's " +
  `transcript with \`granola_get_note\`. If you were given a noteId but ` +
  "have no way to fetch it — no Granola tool available, or the fetch " +
  "fails — say so plainly in one sentence and stop. If neither " +
  "`transcript` nor `noteId` is given, or the transcript you end up " +
  "with is empty, reply with one plain sentence saying you have no " +
  "transcript to work from and stop. Never invent a transcript, pain " +
  "points, or collateral.\n\n" +
  "Extraction: from the transcript, identify the customer's real pain " +
  "points — specific problems they described, not generic categories.\n\n" +
  "Drafting: draft one piece of collateral that speaks directly to the " +
  "most significant pain point you found.\n\n" +
  `Finalizing: call \`${PAIN_POINT_COLLATERAL_FINALIZE_TOOL_NAME}\` ` +
  "exactly once, with a short title, the exact pain point you are " +
  "targeting, and the drafted collateral body. This call requires a " +
  "human's approval before it completes.\n\n" +
  "If the call succeeds, present the finalized collateral as your " +
  "reply — the title, then the body, clearly formatted — with no " +
  "commentary about the approval mechanism itself. If the call is " +
  "denied, reply with one calm, plain sentence that the collateral was " +
  "not approved and no action was taken; never present a denial as an " +
  "error, and never apologize as if something broke.";

/** Tool packages this definition pins (CL-5999); see the header comment. */
export const PAIN_POINT_COLLATERAL_TOOL_PACKAGE_PINS: readonly ToolPackagePin[] =
  [{ name: "@corbits/granola-tools", version: "0.0.1" }];

/**
 * Everything the definition needs that is per-deployment data. The
 * trigger address names a specific deployment's inbox — for this
 * workflow, the address a human messages to start a run — so a
 * definition built here is per-deployment by construction.
 */
export interface PainPointCollateralWorkflowInput {
  /** The deployment's mail address; each inbound mail is one run. */
  readonly triggerAddress: string;
  /** Provider/model preferences, in order; resolved at deploy time. */
  readonly inferencePreferences: readonly InferencePreference[];
  /** Per-turn timeout in milliseconds, enforced on the single step. */
  readonly turnTimeoutMs: number;
}

/**
 * Builds the pain-point-collateral definition. Exactly one step,
 * matching the shape every other definition in this repo commits to.
 *
 * The step always sets an explicit `timeout` — the singular `agent:`
 * shorthand sets none, and a wedged inference call (or one parked on an
 * unresolved approval past a sane bound) would otherwise hang a run
 * forever. Tools are never inlined on the definition: they arrive as
 * packages on the deploy, keeping the definition pure data.
 */
export function buildPainPointCollateralWorkflow(
  input: PainPointCollateralWorkflowInput,
): WorkflowDefinition {
  if (input.triggerAddress === "") {
    throw new Error(
      "buildPainPointCollateralWorkflow requires a non-empty triggerAddress",
    );
  }
  if (!Number.isInteger(input.turnTimeoutMs) || input.turnTimeoutMs <= 0) {
    throw new Error(
      "buildPainPointCollateralWorkflow requires turnTimeoutMs to be a positive integer",
    );
  }
  return defineWorkflow({
    id: PAIN_POINT_COLLATERAL_WORKFLOW_ID,
    trigger: { type: "mail", to: input.triggerAddress },
    steps: {
      [PAIN_POINT_COLLATERAL_STEP_ID]: step({
        agent: {
          id: PAIN_POINT_COLLATERAL_STEP_ID,
          description:
            "Drafts sales collateral targeted at a call transcript's " +
            "pain points and finalizes it only once a human approves",
          systemPrompt: PAIN_POINT_COLLATERAL_SYSTEM_PROMPT,
          toolFactories: [],
          capabilities: [],
          inference: { sources: input.inferencePreferences },
          toolPackagePins: PAIN_POINT_COLLATERAL_TOOL_PACKAGE_PINS,
        } satisfies AgentDefinition,
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
export function serializePainPointCollateralWorkflow(
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

export {
  PAIN_POINT_COLLATERAL_FINALIZE_TOOL,
  PAIN_POINT_COLLATERAL_FINALIZE_TOOL_NAME,
  PAIN_POINT_COLLATERAL_FINALIZE_DESCRIPTION,
  buildArtifactPayload,
} from "./finalize-tool";
export type { ArtifactPayload, FinalizeArgs } from "./finalize-tool";
