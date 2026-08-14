// The last-30-days-research workflow: a single mail-triggered step whose
// agent researches a topic across a handful of source platforms and
// writes it up as one long-form, cited research report. Ported from the
// OG gtm-workbench's `last30days-research` workflow (CL-5997, a child of
// CL-5987's routines-catalog port).
//
// Scoped down per the porting survey's recommendation: the OG fanned out
// across seven source platforms (Hacker News, GitHub, web search via Exa,
// Reddit, X, YouTube, Polymarket — Bluesky was already disabled upstream
// for broken auth, so it never counted as a live source and is skipped
// here too). Building seven new tool integrations at once to land this
// workflow would block the whole port on the size of that gap list. This
// first port wires the two sources with an honest backend ready today —
// `web_search` (`@corbits/web-search-tools`, Exa-backed, the same
// provider the OG called) and `github_activity` (`@corbits/github-tools`,
// GitHub's public REST search, keyless-capable) — and names the
// remaining five as pending sources in the prompt, morning-brief style
// (see `@corbits/morning-brief-workflow`, CL-5993): honestly "not yet
// connected" rather than silently dropped, so the report's shape stays
// stable as each one gets its own tool package later.
//
// Structural difference from the OG: the OG split the pipeline across
// several bespoke tools (`last30days_ground_queries`,
// `last30days_collect`, `last30days_core_report`, ...) that existed only
// to serve this one workflow's step graph. Grounding queries, collecting
// results, and folding them into a structured brief are all folded
// directly into this definition's system prompt instead — a workflow-
// owned constant, not a workflow-shaped tool package — matching every
// other single-step port in this catalog (morning-brief, pain-point-
// collateral, collateral-generation). Only the genuinely reusable
// integrations stay external tool packages.
//
// Persistence (CL-6029): `@corbits/pain-point-collateral-workflow` and
// `@corbits/collateral-generation-workflow` both proved (CL-6000) that a
// workflow tool package CAN reach the Library engine, via
// `createWorkflowArtifact` against the sanctioned workflow-artifacts
// HTTP surface — the "no workflow tool package can reach the Library
// engine yet" gap this file used to document here is stale. This
// definition now closes it the same way: `finalize-tool.ts`'s
// `last_30_days_research_finalize`, gated behind a single human approval
// (`approval: "ask"`, the platform's native tool-approval gate — see
// that file's header for the full suspend/resume account), persists the
// report as a Library artifact and returns `{ id, version, title, kind,
// persisted: true }`, the shape `packages/chat/src/artifact-delivery.ts`
// recognizes and turns into a Library-linked chip in the thread. Every
// run now ends in a persisted artifact — a real report, or (on the
// no-data path) an honest teaching payload — never a bare markdown
// reply.
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

import { LAST_30_DAYS_RESEARCH_FINALIZE_TOOL_NAME } from "./finalize-tool";

export const LAST_30_DAYS_RESEARCH_WORKFLOW_ID = "wf_last_30_days_research";
export const LAST_30_DAYS_RESEARCH_STEP_ID = "last-30-days-research";

// Fixed section structure for the report. A single named export so a
// future delivery-card renderer can recognise these headings rather than
// re-deriving them from prose.
export const LAST_30_DAYS_RESEARCH_SECTIONS = [
  "Overview",
  "Key findings",
  "Sources consulted",
  "Citations",
] as const;

// Sources this deployment can actually reach today, each backed by a
// real, pinnable tool package. See this file's header comment for why
// the other five are scoped out of this first port rather than silently
// degraded.
export const LAST_30_DAYS_RESEARCH_WIRED_SOURCES = [
  "Web search",
  "GitHub",
] as const;
export const LAST_30_DAYS_RESEARCH_PENDING_SOURCES = [
  "Hacker News",
  "Reddit",
  "X",
  "YouTube",
  "Polymarket",
] as const;

export const LAST_30_DAYS_RESEARCH_SYSTEM_PROMPT = [
  "You research a topic across the last 30 days and write it up as one " +
    "long-form, cited research report.",
  "Intake: the trigger carries a `topic` and an optional `focus`. If " +
    "`topic` is missing or empty, reply with one plain sentence saying " +
    "you have no topic to research and stop — never invent a topic. " +
    "When `focus` is given, let it narrow which angle of the topic you " +
    "chase across every source.",
  "Grounding: before searching, work out one tailored query per wired " +
    "source below — narrow, specific keyword terms, not the raw topic " +
    "string verbatim.",
  "Gathering: call `web_search` and `github_activity` (when available), " +
    "each at most once, with your tailored query for that source. A " +
    "tool call that comes back as an error (missing credential, rate " +
    "limit, failed request) means that source is not reachable right " +
    "now — note it plainly and move on. Never fail the report because " +
    "one source is unavailable, and never invent results for a source " +
    "you could not reach.",
  `${LAST_30_DAYS_RESEARCH_PENDING_SOURCES.join(", ")} have no workbench ` +
    `integration yet: always name them as "not yet connected" rather ` +
    `than a real result set — never fabricate discussion, launches, or ` +
    `activity for them.`,
  "Synthesis: rerank what you gathered for relevance to the topic and " +
    "focus, drop anything off-topic, and fold what remains into a " +
    "structured brief before writing.",
  "Structure the reply as markdown with exactly these four section " +
    `headings, in order: "${LAST_30_DAYS_RESEARCH_SECTIONS[0]}", ` +
    `"${LAST_30_DAYS_RESEARCH_SECTIONS[1]}", ` +
    `"${LAST_30_DAYS_RESEARCH_SECTIONS[2]}", ` +
    `"${LAST_30_DAYS_RESEARCH_SECTIONS[3]}". Every claim in Key ` +
    "findings must trace to a citation in the Citations section (link " +
    "plus one-line source description); never state something as fact " +
    "without a citation behind it.",
  "Sources consulted must name which sources you actually reached, " +
    "which ones errored or were unreachable, and which are not yet " +
    "connected — an honest accounting, not a hidden failure.",
  "If every wired source is unreachable, say so plainly at the top " +
    '("no source results to report for this topic") instead of ' +
    "presenting empty or padded sections as if there were real content.",
  `Finalizing: once you have written the report, call ` +
    `\`${LAST_30_DAYS_RESEARCH_FINALIZE_TOOL_NAME}\` exactly once with ` +
    `outcome "report", a short title (e.g. "Last 30 days: <topic>"), ` +
    "and the full markdown report as content. This call requires a " +
    "human's approval before it completes. Always finalize, even when " +
    "no wired source returned anything for the topic: in that case, " +
    `still call \`${LAST_30_DAYS_RESEARCH_FINALIZE_TOOL_NAME}\` once ` +
    'with outcome "status-note", a teaching title (e.g. "Last 30 ' +
    'days: <topic> — no results yet"), and content that honestly ' +
    "explains what it searched for, names the missing or unreachable " +
    "connectors by id (`exa` for web search; `scrapecreators` would " +
    "back a future Reddit source), and says what to do next (connect " +
    "the missing credential, or try a narrower topic or focus). Never " +
    "end a run without finalizing — a plain reply with no artifact is " +
    "not an acceptable outcome, even on the no-data path.",
  "If the finalize call succeeds, present the finalized report as " +
    "your reply exactly as written, with no commentary about the " +
    "approval mechanism itself. If the call is denied, reply with one " +
    "calm, plain sentence that the report was not approved and no " +
    "action was taken; never present a denial as an error, and never " +
    "apologize as if something broke.",
].join("\n\n");

/**
 * Everything the definition needs that is per-deployment data. The
 * trigger address names a specific deployment's inbox — for this
 * workflow, the address a human messages with a topic to start a run —
 * so a definition built here is per-deployment by construction.
 */
export interface Last30DaysResearchWorkflowInput {
  /** The deployment's mail address; each inbound mail is one run. */
  readonly triggerAddress: string;
  /** Provider/model preferences, in order; resolved at deploy time. */
  readonly inferencePreferences: readonly InferencePreference[];
  /** Per-turn timeout in milliseconds, enforced on the single step. */
  readonly turnTimeoutMs: number;
}

/**
 * Builds the last-30-days-research definition. Exactly one step,
 * matching the shape every other definition in this repo commits to: a
 * single reasoning-with-tools turn that calls each source tool at most
 * once and writes the report, rather than a multi-step DAG of bespoke
 * grounding/collect/report tools.
 *
 * The step always sets an explicit `timeout` — the singular `agent:`
 * shorthand sets none, and a wedged inference call (this workflow's turn
 * fans out to multiple sources and writes a long-form report, so it runs
 * longer than a short brief) would otherwise hang a run forever. Tools
 * are never inlined on the definition: they arrive as packages on the
 * deploy (`@corbits/web-search-tools`, `@corbits/github-tools`), keeping
 * the definition pure data.
 */
export function buildLast30DaysResearchWorkflow(
  input: Last30DaysResearchWorkflowInput,
): WorkflowDefinition {
  if (input.triggerAddress === "") {
    throw new Error(
      "buildLast30DaysResearchWorkflow requires a non-empty triggerAddress",
    );
  }
  if (!Number.isInteger(input.turnTimeoutMs) || input.turnTimeoutMs <= 0) {
    throw new Error(
      "buildLast30DaysResearchWorkflow requires turnTimeoutMs to be a positive integer",
    );
  }
  return defineWorkflow({
    id: LAST_30_DAYS_RESEARCH_WORKFLOW_ID,
    trigger: { type: "mail", to: input.triggerAddress },
    steps: {
      [LAST_30_DAYS_RESEARCH_STEP_ID]: step({
        agent: defineAgent({
          id: LAST_30_DAYS_RESEARCH_STEP_ID,
          description:
            "Researches a topic across the last 30 days over a handful " +
            "of source platforms and writes a long-form, cited report",
          systemPrompt: LAST_30_DAYS_RESEARCH_SYSTEM_PROMPT,
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
export function serializeLast30DaysResearchWorkflow(
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
  LAST_30_DAYS_RESEARCH_FINALIZE_TOOL,
  LAST_30_DAYS_RESEARCH_FINALIZE_TOOL_NAME,
  LAST_30_DAYS_RESEARCH_FINALIZE_DESCRIPTION,
  buildArtifactPayload,
} from "./finalize-tool";
export type { ArtifactPayload, FinalizeArgs } from "./finalize-tool";
