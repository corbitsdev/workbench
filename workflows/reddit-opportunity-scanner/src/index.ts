// The reddit-opportunity-scanner workflow (CL-5994, ported from
// `gtm-workbench`'s `workflows/reddit-opportunity-scanner`, child of
// CL-5987): turns one target website into a short list of scored Reddit
// opportunities worth engaging with, with a search-plan review and one
// human approval before anything is persisted.
//
// One step, one agent — matching the shape every other definition in
// this catalog commits to (`step`/`defineAgent`, mail-triggered, tools
// arrive as packages on the deploy, never inlined here). All
// workflow-specific logic — how the intake URL becomes a business
// summary, what counts as a good keyword/subreddit pair, how results get
// ranked into scored opportunities, the exact wording of an honest
// "nothing to scan" reply — lives in this definition's own system prompt
// and its one workflow-local tool (`./finalize-tool.ts`), not a separate
// tool package. The one genuinely reusable piece, searching Reddit, is
// `reddit_search` / `reddit_subreddit_search` from `@corbits/reddit-tools`
// (via ScrapeCreators — see that package's README for why Reddit's own
// API is not used).
//
// Gate consolidation (same convention `collateral-generation`, CL-5996,
// established): the OG `gtm-workbench` implementation suspended for a
// human twice — a search-plan review (edit/approve the candidate
// keyword+subreddit list) and an opportunity-selection review (pick which
// scored opportunities to keep). Neither is, on its own, the platform's
// approval-suspend primitive: they are ordinary questions a chat-native
// agent asks in the course of one conversation. This port asks both in
// the same conversation (see the system prompt below) and keeps exactly
// one real approval gate: finalizing the opportunities the sender chose
// to keep, all at once, in a single
// `reddit_opportunity_scanner_finalize` call. See `./finalize-tool.ts`'s
// header for the full account, including the known "selection is
// approve-all-proposed/deny-all, not per-item editing" limit this
// consolidation carries versus the OG's dedicated selection UI.
//
// Site scraping (Firecrawl) is out of scope for this port: CL-5994's
// dependency survey found no corbits/Interchange Firecrawl tool package,
// and building one is a separate concern from the Reddit tooling this
// ticket owns. The prompt below names `firecrawl_scrape` as the tool this
// workflow would use once that package exists, and commits to an honest
// "no way to scrape" reply in the meantime — the same shape as every
// other honestly-degraded source in this catalog.
//
// Known platform gap (see `finalize-tool.ts`'s header for the full
// account, and this package's README for the reader-facing version): no
// production workflow builder in this repo threads a caller-supplied
// `toolPackagePins` onto a built definition yet (CL-5999,
// `docs/AGENTS-PAGE.md`), the same gap `@corbits/morning-brief-workflow`
// (CL-5993), `@corbits/pain-point-collateral-workflow` (CL-5995), and
// `@corbits/collateral-generation-workflow` (CL-5996) document. Until
// that lands, this definition's step ships with `tools: []`, matching
// every other definition in this catalog — its system prompt commits it
// to saying plainly when it has no way to scrape a site, search Reddit,
// or finalize opportunities, rather than inventing scraped content,
// search results, or an approval that never happened.
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

import {
  REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL_NAME,
  REDDIT_OPPORTUNITY_SCANNER_REPORT_NO_RESULTS_TOOL_NAME,
} from "./finalize-tool";

export const REDDIT_OPPORTUNITY_SCANNER_WORKFLOW_ID =
  "wf_reddit_opportunity_scanner";
export const REDDIT_OPPORTUNITY_SCANNER_STEP_ID = "reddit-opportunity-scanner";

export const REDDIT_OPPORTUNITY_SCANNER_SYSTEM_PROMPT = [
  "You turn one target website into a short list of scored Reddit " +
    "opportunities — posts worth engaging with for outreach or content " +
    "ideas — with a search-plan review and exactly one human approval " +
    "before anything is finalized.",

  "Intake: the sender's message names one target website URL. If no URL " +
    "is given, ask for one and wait for the answer. Never guess a URL " +
    "or scan a site the sender did not name.",

  "Scraping: use firecrawl_scrape (when available) to fetch the site's " +
    "content. If firecrawl_scrape is not available, or the fetch fails, " +
    "say so plainly in one sentence and stop — never fabricate what the " +
    "site sells.",

  "Analysis: from the scraped content, infer what the business sells, " +
    "its likely customers, and a candidate list of Reddit search " +
    "keywords and subreddits worth searching for opportunities.",

  "Search-plan review: present the candidate keywords, subreddits, and a " +
    "one-paragraph summary of what the business sells to the sender, and " +
    "ask them to edit or approve the list before anything is searched. " +
    "Wait for their answer; never search Reddit before this is approved.",

  "Searching: for each approved subreddit, call reddit_subreddit_search " +
    "with the matching keyword; for any approved keyword with no " +
    "specific subreddit, call reddit_search instead. A search call that " +
    "errors means that pair is not reachable right now — say so plainly " +
    "and continue with the others; never fail the whole run because one " +
    "search failed. If every search is unreachable, or none return any " +
    "results, call " +
    REDDIT_OPPORTUNITY_SCANNER_REPORT_NO_RESULTS_TOOL_NAME +
    " exactly once with an honest account: the target URL, one line per " +
    "keyword/subreddit pair actually attempted (or an empty list if none " +
    "were reachable), the connector id this run could not reach if that " +
    'is why nothing came back (e.g. "scrapecreators", the connector ' +
    "reddit_search and reddit_subreddit_search need — leave this empty " +
    "if every search WAS reachable and simply found nothing), and a " +
    "plain next step for the sender (connect the missing connector, or " +
    "try a different target URL). This call needs no approval — nothing " +
    "was selected, so there is nothing to confirm. After it returns, " +
    "give the sender the same honest account as your reply; never " +
    "invent posts to fill the gap, and never leave the sender with a " +
    "reply and nothing else.",

  "Ranking: score every result found from 1 (weak fit, off-topic, or " +
    "outdated) to 5 (an explicit buying signal or urgent, specific pain " +
    "point), and draft a short engagement brief for each — why it " +
    "matters and a suggested angle for replying. Keep only opportunities " +
    "that are a genuine fit; never pad the list with weak or off-topic " +
    "results just to have more to show.",

  "Opportunity selection: present the ranked opportunities to the " +
    "sender — title, subreddit, score, and why it matters for each — " +
    "and ask which to keep. Wait for their answer.",

  `Finalizing: call ${REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL_NAME} ` +
    "exactly once with the full set of opportunities the sender chose " +
    "to keep. This call requires a human's approval before it " +
    "completes. Never call it more than once per run, with an empty " +
    "set, or with an opportunity the sender did not select.",

  "If the call succeeds, present the finalized opportunities as your " +
    "reply — each title, subreddit, score, and brief, clearly formatted " +
    "— with no commentary about the approval mechanism itself. If the " +
    "call is denied, reply with one calm, plain sentence that the " +
    "opportunities were not approved and no action was taken; never " +
    "present a denial as an error, and never apologize as if something " +
    "broke.",
].join("\n\n");

/**
 * Everything the definition needs that is per-deployment data. The
 * trigger address names a specific deployment's inbox — for this
 * workflow, the address a human messages to start a run — so a
 * definition built here is per-deployment by construction.
 */
export interface RedditOpportunityScannerWorkflowInput {
  /** The deployment's mail address; each inbound mail is one run. */
  readonly triggerAddress: string;
  /** Provider/model preferences, in order; resolved at deploy time. */
  readonly inferencePreferences: readonly InferencePreference[];
  /** Per-turn timeout in milliseconds, enforced on the single step. */
  readonly turnTimeoutMs: number;
}

/**
 * Builds the reddit-opportunity-scanner definition. Exactly one step,
 * matching the shape every other definition in this repo commits to.
 *
 * The step always sets an explicit `timeout` — the singular `agent:`
 * shorthand sets none, and a wedged inference call (or one parked on an
 * unresolved approval past a sane bound) would otherwise hang a run
 * forever. Tools are never inlined on the definition: they arrive as
 * packages on the deploy, keeping the definition pure data.
 */
export function buildRedditOpportunityScannerWorkflow(
  input: RedditOpportunityScannerWorkflowInput,
): WorkflowDefinition {
  if (input.triggerAddress === "") {
    throw new Error(
      "buildRedditOpportunityScannerWorkflow requires a non-empty triggerAddress",
    );
  }
  if (!Number.isInteger(input.turnTimeoutMs) || input.turnTimeoutMs <= 0) {
    throw new Error(
      "buildRedditOpportunityScannerWorkflow requires turnTimeoutMs to be a positive integer",
    );
  }
  return defineWorkflow({
    id: REDDIT_OPPORTUNITY_SCANNER_WORKFLOW_ID,
    trigger: { type: "mail", to: input.triggerAddress },
    steps: {
      [REDDIT_OPPORTUNITY_SCANNER_STEP_ID]: step({
        agent: defineAgent({
          id: REDDIT_OPPORTUNITY_SCANNER_STEP_ID,
          description:
            "Scans a target website's likely Reddit audience for " +
            "engagement-worthy opportunities and finalizes only the " +
            "ones a human selects and approves",
          systemPrompt: REDDIT_OPPORTUNITY_SCANNER_SYSTEM_PROMPT,
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
export function serializeRedditOpportunityScannerWorkflow(
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
  REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL,
  REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL_NAME,
  REDDIT_OPPORTUNITY_SCANNER_FINALIZE_DESCRIPTION,
  REDDIT_OPPORTUNITY_SCANNER_REPORT_NO_RESULTS_TOOL_NAME,
  REDDIT_OPPORTUNITY_SCANNER_REPORT_NO_RESULTS_DESCRIPTION,
  buildArtifactPayloads,
  buildNoResultsArtifactPayload,
} from "./finalize-tool";
export type {
  ArtifactPayload,
  FinalizeArgs,
  NoResultsReportArgs,
  RedditOpportunity,
} from "./finalize-tool";
