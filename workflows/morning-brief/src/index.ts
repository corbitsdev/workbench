// The morning-brief workflow: a single-step, mail-triggered definition
// whose agent pulls the caller's recent activity across connected
// sources and writes it up as one calm, scannable brief. Ported from
// the OG gtm-workbench's `heartbeat` workflow (CL-5993) — renamed to
// avoid colliding with this repo's own zero-cost `heartbeat` catalog-
// test fixture, which is an unrelated definition.
//
// Structural difference from the OG: the OG split brief assembly
// across several bespoke tools (`heartbeat_merge_brief_sources`,
// `heartbeat_format_brief_title`, `heartbeat_format_brief_document`,
// `heartbeat_format_brief_notify`) that existed only to serve this one
// workflow. Everything that specific to morning-brief — the section
// structure, the per-source degradation copy — is folded directly into
// this definition's system prompt instead: a workflow-owned constant,
// not a workflow-shaped tool package. Only the genuinely reusable
// integrations (Granola, Linear) stay external tool packages
// (`@corbits/granola-tools`, `@corbits/linear-tools`), the same way
// every other tool a workbench agent uses arrives as a package pinned
// at deploy time — never inlined on the definition (see the boundary
// test in `test/boundary.test.ts`).
//
// This package is installable data. It imports only published platform
// packages, and nothing imports it statically: a host publishes the
// serialized definition as a workflow asset and deploys it through the
// platform's deploy machinery; the execution host materializes it at
// runtime from the deploy alone.

import { defineAgent } from "@intx/agent";
import type { InferencePreference } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";

export const MORNING_BRIEF_WORKFLOW_ID = "wf_morning_brief";
export const MORNING_BRIEF_STEP_ID = "morning-brief";

// Fixed section structure, matching the OG brief's shape. Kept as a
// single named export so a future consumer (e.g. a delivery-card
// renderer that wants to recognise these headings) reads the same
// three strings the prompt commits the model to, rather than
// re-deriving them from prose.
export const MORNING_BRIEF_SECTIONS = [
  "What happened",
  "What needs attention today",
  "Suggested next actions",
] as const;

// Sources this deployment can actually reach today, each backed by a
// real, pinnable tool package. Attio and Vercel have no workbench tool
// package yet (CL-5993's survey found neither corbits/Interchange
// integration exists) — they are named in the prompt as honestly
// "not connected" rather than silently omitted, so the brief's shape
// stays stable as sources come online: adding Attio later means giving
// it a tool package and a line here, never restructuring the brief.
export const MORNING_BRIEF_WIRED_SOURCES = ["Granola", "Linear"] as const;
export const MORNING_BRIEF_PENDING_SOURCES = ["Attio", "Vercel"] as const;

export const MORNING_BRIEF_SYSTEM_PROMPT = [
  "You write a short daily brief summarizing the sender's recent " +
    "activity, for the sender to read at the start of their day.",
  "Use the granola_list_recent_notes and linear_list_recent_issues " +
    "tools (when available) to pull what actually happened — recent " +
    "Granola call notes and recently updated Linear issues. Call each " +
    "at most once per source.",
  "A tool call that comes back as an error (missing credential, " +
    "failed request) means that source is not connected right now — " +
    'note it plainly (e.g. "Linear: not connected") and move on. ' +
    "Never fail the brief because one source is unavailable, and never " +
    "invent activity for a source you could not reach.",
  `Attio and Vercel have no workbench integration yet: always list ` +
    `them as "not connected" rather than a real section — never ` +
    `fabricate CRM or deployment activity for them.`,
  "Structure the reply as markdown with exactly these three section " +
    `headings, in order: "${MORNING_BRIEF_SECTIONS[0]}", ` +
    `"${MORNING_BRIEF_SECTIONS[1]}", "${MORNING_BRIEF_SECTIONS[2]}". ` +
    "Keep it calm and scannable: short bullet points, no filler, no " +
    "restating the tool output verbatim.",
  "If every source is not connected, say that plainly at the top " +
    '("no connected sources to report from today") instead of ' +
    "presenting empty or padded sections as if there were real content.",
].join("\n\n");

/**
 * Everything the definition needs that is per-deployment data. The
 * trigger address names a specific deployment's inbox; a routine's
 * scheduled fire (see `@corbits/routines`) launches this definition
 * directly and is independent of this field, matching how every other
 * workflow package in this catalog is authored.
 */
export interface MorningBriefWorkflowInput {
  /** The deployment's mail address; each inbound mail is one run. */
  readonly triggerAddress: string;
  /** Provider/model preferences, in order; resolved at deploy time. */
  readonly inferencePreferences: readonly InferencePreference[];
  /** Per-turn timeout in milliseconds, enforced on the single step. */
  readonly turnTimeoutMs: number;
}

/**
 * Builds the morning-brief definition. Exactly one step, matching the
 * shape every other definition in this repo commits to: a single
 * reasoning-with-tools turn that calls each source tool at most once
 * and writes the brief, rather than a multi-step DAG of bespoke
 * formatting tools.
 *
 * The step always sets an explicit `timeout` — the singular `agent:`
 * shorthand sets none, and a wedged inference call would then hang a
 * run forever. Tools are never inlined on the definition: they arrive
 * as packages on the deploy (`@corbits/granola-tools`,
 * `@corbits/linear-tools`), keeping the definition pure data.
 */
export function buildMorningBriefWorkflow(
  input: MorningBriefWorkflowInput,
): WorkflowDefinition {
  if (input.triggerAddress === "") {
    throw new Error(
      "buildMorningBriefWorkflow requires a non-empty triggerAddress",
    );
  }
  if (!Number.isInteger(input.turnTimeoutMs) || input.turnTimeoutMs <= 0) {
    throw new Error(
      "buildMorningBriefWorkflow requires turnTimeoutMs to be a positive integer",
    );
  }
  return defineWorkflow({
    id: MORNING_BRIEF_WORKFLOW_ID,
    trigger: { type: "mail", to: input.triggerAddress },
    steps: {
      "morning-brief": step({
        agent: defineAgent({
          id: MORNING_BRIEF_STEP_ID,
          description:
            "Pulls recent activity across the sender's connected " +
            "sources and writes it up as a short daily brief",
          systemPrompt: MORNING_BRIEF_SYSTEM_PROMPT,
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
export function serializeMorningBriefWorkflow(
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
