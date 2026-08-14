// The collateral-generation workflow (CL-5996, ported from
// `gtm-workbench`'s `workflows/multi-source-collateral`, child of
// CL-5987): drafts one piece of marketing collateral per content type
// the human picks, grounded in one or more sources the human picks, with
// a swipe review per piece and one human approval before anything is
// finalized.
//
// One step, one agent — matching the shape every other definition in
// this catalog commits to (`step`/`defineAgent`, mail-triggered, tools
// arrive as packages on the deploy, never inlined here). All
// workflow-specific logic — the exact source and content-type choices
// offered, how sources merge into one context, the per-content-type
// drafting guidance, the swipe-review and one-revise-pass rules, the
// exact wording of an honest "nothing to draft from" reply — lives in
// this definition's own system prompt and its one workflow-local tool
// (`./finalize-tool.ts`), not a separate tool package: none of it is a
// reusable integration on its own. The genuinely reusable pieces —
// fetching a Granola note by id and listing recently updated Linear
// issues — are `granola_get_note` (`@corbits/granola-tools`) and
// `linear_list_recent_issues` (`@corbits/linear-tools`), the same
// packages `pain-point-collateral` and `morning-brief` pin.
//
// Gate consolidation (see `finalize-tool.ts`'s header for the full
// account): the OG suspended for a human four times — source pick,
// content-type pick, per-piece swipe review, and a second review of
// anything regenerated. Only the last step needs the platform's real
// approval-suspend mechanism; the rest are ordinary conversational turns
// in this port, matching how every other definition in this catalog asks
// for input. This definition keeps exactly one approval gate: finalizing
// every piece the human approved, all at once.
//
// Tool-package pins (CL-5999): `@intx/agent`'s `defineAgent` still does
// not accept a `toolPackagePins` field on its authoring-time config —
// it is vendored, read-only source for this change — so the agent
// below is built directly against `AgentDefinition`'s own type, which
// already carries the field. `@corbits/granola-tools` and
// `@corbits/linear-tools` are pinned below; whether either pin
// *resolves* at deploy time still depends on an operator publishing it
// to a registry the host's tool-package resolver can reach (see
// `apps/hub/src/index.ts`'s `toolPackageRegistries` wiring).
// `@corbits/artifact-tools` (the read-side account in its own README)
// stays unpinned: its one tool still cannot reach the Library engine
// itself (CL-6000), so pinning it would resolve a package whose tool
// cannot do anything yet. See `finalize-tool.ts`'s header for the
// separate, still-open write-side gap. Until deploys actually resolve
// the pins below, this definition's system prompt still commits it to
// saying plainly when it has no way to reach a source or finalize a
// piece, rather than inventing source material or an approval that
// never happened.
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

import { COLLATERAL_GENERATION_FINALIZE_TOOL_NAME } from "./finalize-tool";

export const COLLATERAL_GENERATION_WORKFLOW_ID = "wf_collateral_generation";
export const COLLATERAL_GENERATION_STEP_ID = "collateral-generation";

/**
 * Content types this workflow can draft, matching the OG's seven-type
 * catalog. Named export so a future consumer (e.g. a picker UI wanting
 * the same ids) reads the same list the prompt commits the model to,
 * rather than re-deriving it from prose.
 */
export const COLLATERAL_CONTENT_TYPES = [
  {
    id: "linkedin-post",
    label: "LinkedIn post",
    guidance:
      "A hook in the first two lines, one clear insight grounded in the " +
      "sources, and a close on a reflective question rather than a hard " +
      "call to action. Around 120-220 words.",
  },
  {
    id: "linkedin-article",
    label: "LinkedIn article",
    guidance:
      "A long-form piece: an opening narrative hook, two to four " +
      "sections with headers developing the point, concrete (but " +
      "generalized) examples, and a practical closing takeaway. Around " +
      "600-1000 words.",
  },
  {
    id: "twitter-post",
    label: "Twitter/X post",
    guidance:
      "One sharp idea, not a thread. Under 280 characters where " +
      "possible, never over 500. No hashtag stacking, no emoji pile-on.",
  },
  {
    id: "twitter-article",
    label: "Twitter/X article",
    guidance:
      "A strong title line followed by a scannable multi-section body. " +
      "Around 400-800 words.",
  },
  {
    id: "blog-short",
    label: "Short blog post",
    guidance:
      "Hook, problem, insight, takeaway. Headers used sparingly, " +
      "conversational and paste-ready. Around 400-600 words.",
  },
  {
    id: "blog-mid",
    label: "Mid-length blog post",
    guidance:
      "A narrative arc across clear sections, with examples and " +
      "practical advice. Around 800-1200 words.",
  },
  {
    id: "blog-long",
    label: "Long-form blog post",
    guidance:
      "A deeper piece: context, problem, analysis, recommendations, " +
      "across multiple sections. Around 1500-2200 words.",
  },
] as const;

/** Sources this deployment can actually reach today, each backed by a
 * real, pinnable tool package. Workbench artifacts reach the Library
 * engine for real now (CL-6000) but still have no way to land on a
 * deployed definition — `@corbits/artifact-tools` is pinnable the moment
 * CL-5999's tool-pin gap closes — so it is named honestly as "not
 * connected" here rather than silently omitted. */
export const COLLATERAL_GENERATION_WIRED_SOURCES = [
  "Granola call notes",
  "Linear issues",
] as const;
export const COLLATERAL_GENERATION_PENDING_SOURCES = [
  "workbench artifacts",
] as const;

/**
 * Tool packages this definition pins (CL-5999), one per wired source in
 * `COLLATERAL_GENERATION_WIRED_SOURCES`; see the header comment for why
 * `@corbits/artifact-tools` stays unpinned.
 */
export const COLLATERAL_GENERATION_TOOL_PACKAGE_PINS: readonly ToolPackagePin[] =
  [
    { name: "@corbits/granola-tools", version: "0.0.1" },
    { name: "@corbits/linear-tools", version: "0.0.1" },
  ];

const CONTENT_TYPE_LINES = COLLATERAL_CONTENT_TYPES.map(
  (type) => `- "${type.id}" (${type.label}): ${type.guidance}`,
).join("\n");

export const COLLATERAL_GENERATION_SYSTEM_PROMPT = [
  "You draft marketing collateral from one or more sources the sender " +
    "picks, in one or more content types the sender picks, with a " +
    "swipe review on every draft and exactly one human approval before " +
    "anything is finalized.",

  "Source pick: first, ask which source(s) to draw from — Granola call " +
    "notes (fetched by note id with granola_get_note), Linear issues " +
    "(from linear_list_recent_issues), and/or text pasted directly into " +
    "the conversation. Workbench artifacts are not yet a reachable " +
    "source for this workflow — say so plainly if asked, never pretend " +
    "to read one. Wait for the sender's answer before doing anything " +
    "else.",

  "Content-type pick: once you know the sources, ask which content " +
    `type(s) to draft, offering exactly these choices:\n${CONTENT_TYPE_LINES}\n` +
    "A run can draft more than one type. Wait for the sender's answer.",

  "Gathering: fetch every picked source with the matching tool. A tool " +
    "result that comes back as an error means that source is not " +
    "reachable right now — say so plainly and continue with whatever " +
    "did load; never fail the whole run because one source is " +
    "unavailable, and never fabricate content for a source you could " +
    "not reach. If nothing you can reach yields any content and no " +
    "pasted text was given either, say plainly that you have nothing " +
    "to draft from and stop — never invent source material.",

  "Drafting: draft one piece per picked content type, each grounded " +
    "only in the gathered source material, following that type's " +
    "guidance above. Ground every claim in the source material — never " +
    "invent facts, quotes, or specifics the sources do not contain. " +
    "These pieces are public: strip or generalize any customer- or " +
    "company-identifying detail you find in the sources. Write plainly " +
    "and specifically — no marketing buzzwords (synergy, leverage, " +
    "unlock, streamline, game-changing, best-in-class), no em dashes, " +
    "no hollow superlatives.",

  "Swipe review: present every draft to the sender and ask for Good, " +
    "Bad, or Regenerate on each, with optional feedback. For any piece " +
    "marked Bad or Regenerate, revise it once — using the feedback " +
    "given, or otherwise making a materially different pass — and " +
    "never revise the same piece a second time. If the sender still " +
    "rejects a piece after that one revision, drop it from the final " +
    "set rather than trying again.",

  `Finalizing: once every drafted piece has a final disposition — ` +
    "approved, or dropped after its one revision — call " +
    `${COLLATERAL_GENERATION_FINALIZE_TOOL_NAME} exactly once with the ` +
    "full set of approved pieces (title, content type, and body for " +
    "each). This call requires a human's approval before it completes. " +
    "Never call it more than once per run, with an empty set, or with " +
    "a piece the sender did not approve.",

  "If the call succeeds, present the finalized pieces as your reply — " +
    "each title and body, clearly formatted — with no commentary about " +
    "the approval mechanism itself. If the call is denied, reply with " +
    "one calm, plain sentence that the pieces were not approved and no " +
    "action was taken; never present a denial as an error, and never " +
    "apologize as if something broke.",
].join("\n\n");

/**
 * Everything the definition needs that is per-deployment data. The
 * trigger address names a specific deployment's inbox — for this
 * workflow, the address a human messages to start a run — so a
 * definition built here is per-deployment by construction.
 */
export interface CollateralGenerationWorkflowInput {
  /** The deployment's mail address; each inbound mail is one run. */
  readonly triggerAddress: string;
  /** Provider/model preferences, in order; resolved at deploy time. */
  readonly inferencePreferences: readonly InferencePreference[];
  /** Per-turn timeout in milliseconds, enforced on the single step. */
  readonly turnTimeoutMs: number;
}

/**
 * Builds the collateral-generation definition. Exactly one step,
 * matching the shape every other definition in this repo commits to.
 *
 * The step always sets an explicit `timeout` — the singular `agent:`
 * shorthand sets none, and a wedged inference call (or one parked on an
 * unresolved approval past a sane bound) would otherwise hang a run
 * forever. Tools are never inlined on the definition: they arrive as
 * packages on the deploy, keeping the definition pure data.
 */
export function buildCollateralGenerationWorkflow(
  input: CollateralGenerationWorkflowInput,
): WorkflowDefinition {
  if (input.triggerAddress === "") {
    throw new Error(
      "buildCollateralGenerationWorkflow requires a non-empty triggerAddress",
    );
  }
  if (!Number.isInteger(input.turnTimeoutMs) || input.turnTimeoutMs <= 0) {
    throw new Error(
      "buildCollateralGenerationWorkflow requires turnTimeoutMs to be a positive integer",
    );
  }
  return defineWorkflow({
    id: COLLATERAL_GENERATION_WORKFLOW_ID,
    trigger: { type: "mail", to: input.triggerAddress },
    steps: {
      [COLLATERAL_GENERATION_STEP_ID]: step({
        agent: {
          id: COLLATERAL_GENERATION_STEP_ID,
          description:
            "Drafts marketing collateral from picked sources and " +
            "content types, with a swipe review per piece and one " +
            "human approval on the final approved set",
          systemPrompt: COLLATERAL_GENERATION_SYSTEM_PROMPT,
          toolFactories: [],
          capabilities: [],
          inference: { sources: input.inferencePreferences },
          toolPackagePins: COLLATERAL_GENERATION_TOOL_PACKAGE_PINS,
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
export function serializeCollateralGenerationWorkflow(
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
  COLLATERAL_GENERATION_FINALIZE_TOOL,
  COLLATERAL_GENERATION_FINALIZE_TOOL_NAME,
  COLLATERAL_GENERATION_FINALIZE_DESCRIPTION,
  buildArtifactPayloads,
} from "./finalize-tool";
export type {
  ArtifactPayload,
  CollateralPiece,
  FinalizeArgs,
} from "./finalize-tool";
