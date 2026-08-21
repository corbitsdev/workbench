// The diligence-brief workflow (CL-6499): a single-step, mail-triggered
// definition that researches a company and writes a cited diligence
// brief as a markdown Library artifact, held for one human approval.
//
// ## Where this comes from
//
// Ported from scout's `workflows/diligence-brief` — a real multi-step
// pipeline there: an outline step plus one PARALLEL step per section
// (team, product, revenue, capital, growth, market, risks), each scored
// against seven weighted dimensions, deterministically assembled into a
// structured `DiligenceBrief` object by a pure-code `assemble-brief`
// action, then rendered. None of that machinery ports as-is:
//
// - Scout's tools (its own artifact/knowledge-search/web-research
//   bundles from `@corbits/scout`) compile into scout's own sidecar and
//   cannot be pinned here (`packages/scout/README.md`, CL-5179). Every
//   tool call is rebound below to a workbench-published package instead:
//   web research -> `@corbits/web-search-tools` (Exa-backed), firm
//   memory -> `@corbits/memory-tools`. Nothing scout-specific is
//   imported.
// - Scout's per-section parallel steps and pure-code assembler assume a
//   deterministic `action` primitive this repo's execution host
//   (`apps/sidecar`) has never wired (the same gap
//   `last-30-days-research`'s header documents at length). Rather than
//   fold seven parallel section steps into seven serial reasoning
//   steps (which would multiply run time and per-step timeout risk for
//   a first port), this port follows `code-review`'s and
//   `collateral-generation`'s single-step shape: one agent, one
//   reasoning turn, tools called inside it.
// - Scout's seven-dimension weighted scoring (`SCORE_WEIGHTS`,
//   `dims`/`dimensionReads`) is cut entirely for this port. It is real
//   product value scout's teammates rely on, and cutting it is an
//   honest scope trim, not an oversight: a scored, per-dimension brief
//   needs the parallel-section machinery above to stay within a single
//   turn's output budget, and that machinery isn't proven on this
//   host yet. This port ships a narrower, PROSE-ONLY brief across five
//   fixed sections (see `DILIGENCE_BRIEF_SECTIONS` below) instead of a
//   500 on every run.
//
// ## What this port keeps faithful
//
// The evidence discipline scout's prompts commit to: ground every claim
// in a tool result, never invent a fact, and say "insufficient evidence"
// plainly rather than filling a section with prose that sounds
// confident but is not sourced. Firm memory is checked first (so a
// second brief on the same company builds on the first), then the web,
// exactly the order scout's own "tool policy" section commits to
// (`artifact refs first... then check knowledge-search... then
// webResearchTool`, minus the artifact-refs step this deployment has no
// equivalent trigger for yet).
//
// ## Delivery
//
// Persisting is gated by human approval, same as every other
// artifact-producing workflow in this catalog (AGENTS.md: "every
// external side effect sits behind human approval") — scout's own
// pipeline has no such gate (CL-6000 predates this repo's Library
// engine), so this is a deliberate policy addition, not a missing
// feature. The persisted artifact is markdown (`kind: "text"`), the
// same shape the sibling Gotenberg PDF-rendering lane already expects
// to render, so this workflow needs no PDF logic of its own.
//
// This package is installable data. It imports only published platform
// packages, and nothing imports it statically: a host publishes the
// serialized definition as a workflow asset and deploys it through the
// platform's deploy machinery; the execution host materializes it at
// runtime from the deploy alone.

import type { AgentDefinition, InferencePreference } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";
import type { CredentialBinding } from "@intx/types";
import type { ToolPackagePin } from "@intx/types/tool-packages";

import { DILIGENCE_BRIEF_FINALIZE_TOOL_NAME } from "./finalize-tool";

export const DILIGENCE_BRIEF_WORKFLOW_ID = "wf_diligence_brief";
export const DILIGENCE_BRIEF_STEP_ID = "diligence-brief";

/**
 * The brief's fixed section outline (trimmed from scout's seven
 * separately-scored sections — see this file's header comment). Team &
 * Founders and Product & Market each keep their own heading since
 * founder/product evidence rarely overlaps; Traction & Funding folds
 * scout's separate revenue/capital-runway/growth-traction sections into
 * one, since a single-turn brief cannot sustain three sections' worth of
 * distinct evidence without either padding or fabricating.
 */
export const DILIGENCE_BRIEF_SECTIONS = [
  "Overview",
  "Team & Founders",
  "Product & Market",
  "Traction & Funding",
  "Risks & Open Questions",
] as const;

export const DILIGENCE_BRIEF_WIRED_SOURCES = [
  "Web search",
  "Firm memory",
] as const;

/**
 * Tool packages this definition pins (CL-5999 shape, matching
 * `code-review`/`collateral-generation`/`assistant`'s precedent):
 * `@corbits/web-search-tools` for live research, `@corbits/memory-tools`
 * so a brief can check (and later inform) the tenant's firm memory.
 */
export const DILIGENCE_BRIEF_TOOL_PACKAGE_PINS: readonly ToolPackagePin[] = [
  { name: "@corbits/web-search-tools", version: "0.0.3" },
  { name: "@corbits/memory-tools", version: "0.0.4" },
];

/**
 * Binds the pinned web-search package's "exa" handle to the tenant's
 * connection — `@corbits/memory-tools` needs no credential binding of
 * its own; its env keys (`hubMemoryUrl`/`sidecarToken`/`address`) are
 * populated for every workflow step directly, the same as
 * `@corbits/artifact-tools`' trio.
 */
export const DILIGENCE_BRIEF_CREDENTIAL_BINDINGS: readonly CredentialBinding[] =
  [
    {
      package: "@corbits/web-search-tools",
      handle: "exa",
      provider: "exa",
      locator: "tenant",
    },
  ];

const SECTION_LINES = DILIGENCE_BRIEF_SECTIONS.map(
  (heading, index) => `${String(index + 1)}. ${heading}`,
).join("\n");

export const DILIGENCE_BRIEF_SYSTEM_PROMPT =
  "You research a company and write one cited diligence brief for the " +
  "sender's own review, then finalize it pending a human's approval.\n" +
  "\n" +
  "## Reading the request\n" +
  "The triggering mail names a `company` (the subject of the brief) and " +
  'an optional `focus` narrowing which angle to dig into (e.g. "go-to-' +
  'market" or "founder track record"). If no company is named, say so ' +
  "in one plain sentence and stop — never draft a brief with no subject.\n" +
  "\n" +
  "## Research order\n" +
  "First call memory_search for the company name: firm memory may " +
  "already hold notes from an earlier brief or conversation. Then call " +
  "web_search (at least twice, with distinct queries — e.g. the company " +
  'name alone, and the company name plus "funding" or "founders") to ' +
  "gather current, public information. A tool call that comes back as " +
  "an error (missing credential, rate limit, failed request) means that " +
  "source is not reachable right now — note it plainly and move on; " +
  "never fail the whole run because one source is unavailable, and " +
  "never invent results for a source you could not reach. If BOTH " +
  "memory_search and every web_search call come back empty or " +
  "unreachable, you have nothing to draft from.\n" +
  "\n" +
  "## Writing the brief\n" +
  `Structure the brief under these five headings, in order:\n${SECTION_LINES}\n` +
  "Ground every claim in a specific tool result — cite it inline (e.g. " +
  '"per web_search: ...") rather than asserting facts with no source. ' +
  "Where evidence is thin or absent for a section, say so plainly " +
  '("insufficient evidence in the sources gathered") rather than ' +
  "padding it with generic industry prose. Never fabricate a founder " +
  "name, a funding round, a metric, or a competitor that no source " +
  "actually named.\n" +
  "\n" +
  "## Finalizing\n" +
  `Once you have written the brief, call \`${DILIGENCE_BRIEF_FINALIZE_TOOL_NAME}\` ` +
  'exactly once with outcome "brief", a short title (e.g. "Diligence ' +
  'brief: <company>"), and the full markdown brief as content. This ' +
  "call requires a human's approval before it completes. If research " +
  "turned up nothing (the no-data case above), still call " +
  `\`${DILIGENCE_BRIEF_FINALIZE_TOOL_NAME}\` once with outcome ` +
  '"status-note", a teaching title (e.g. "Diligence brief: <company> — ' +
  'no results yet"), and content that honestly explains what was ' +
  "searched for, names the missing or unreachable connectors by id " +
  "(`exa` for web search), and says what to do next. Never end a run " +
  "without finalizing — a plain reply with no artifact is not an " +
  "acceptable outcome, even on the no-data path.\n" +
  "\n" +
  "If the finalize call succeeds, present the finalized brief as your " +
  "reply exactly as written, with no commentary about the approval " +
  "mechanism itself. If the call is denied, reply with one calm, plain " +
  "sentence that the brief was not approved and no action was taken; " +
  "never present a denial as an error, and never apologize as if " +
  "something broke.";

/**
 * Everything the definition needs that is per-deployment data. The
 * trigger address names a specific deployment's inbox — for this
 * workflow, the address a human messages with a company name to start
 * a run — so a definition built here is per-deployment by construction.
 */
export interface DiligenceBriefWorkflowInput {
  /** The deployment's mail address; each inbound mail is one run. */
  readonly triggerAddress: string;
  /** Provider/model preferences, in order; resolved at deploy time. */
  readonly inferencePreferences: readonly InferencePreference[];
  /** Per-turn timeout in milliseconds, enforced on the single step. */
  readonly turnTimeoutMs: number;
}

/**
 * Builds the diligence-brief definition. Exactly one step, matching the
 * shape every other definition in this catalog commits to (`code-review`
 * is the closest reference). Tools are never inlined on the definition:
 * they arrive as packages on the deploy, keeping the definition pure
 * data.
 */
export function buildDiligenceBriefWorkflow(
  input: DiligenceBriefWorkflowInput,
): WorkflowDefinition {
  if (input.triggerAddress === "") {
    throw new Error(
      "buildDiligenceBriefWorkflow requires a non-empty triggerAddress",
    );
  }
  if (!Number.isInteger(input.turnTimeoutMs) || input.turnTimeoutMs <= 0) {
    throw new Error(
      "buildDiligenceBriefWorkflow requires turnTimeoutMs to be a positive integer",
    );
  }
  return defineWorkflow({
    id: DILIGENCE_BRIEF_WORKFLOW_ID,
    trigger: { type: "mail", to: input.triggerAddress },
    credentialBindings: DILIGENCE_BRIEF_CREDENTIAL_BINDINGS,
    steps: {
      [DILIGENCE_BRIEF_STEP_ID]: step({
        agent: {
          id: DILIGENCE_BRIEF_STEP_ID,
          description:
            "Researches a company and writes a cited diligence brief, " +
            "finalized pending human approval",
          systemPrompt: DILIGENCE_BRIEF_SYSTEM_PROMPT,
          toolFactories: [],
          capabilities: [],
          inference: { sources: input.inferencePreferences },
          toolPackagePins: DILIGENCE_BRIEF_TOOL_PACKAGE_PINS,
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
export function serializeDiligenceBriefWorkflow(
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
  DILIGENCE_BRIEF_FINALIZE_TOOL,
  DILIGENCE_BRIEF_FINALIZE_TOOL_NAME,
  DILIGENCE_BRIEF_FINALIZE_DESCRIPTION,
  buildArtifactPayload,
} from "./finalize-tool";
export type { ArtifactPayload, FinalizeArgs } from "./finalize-tool";
