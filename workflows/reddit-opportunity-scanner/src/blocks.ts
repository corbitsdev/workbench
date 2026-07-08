/**
 * The reddit-opportunity-scanner workflow's own dock blocks (CL-2769).
 *
 * Migrates TWO of the three HITL gates off the bespoke `ui.tsx` panel and onto
 * the shared UIBlock surface, following the ab-compare-hitl / last30days / gamma
 * pattern: this builder derives the run's dock content from the run's
 * log-derived state plus its decoded step outputs. The `ui.tsx` panel stays as
 * the run-page strangler fallback.
 *
 * Gates:
 *   1. intake — a `form` collecting the website URL (required) + optional brand
 *      / geography / ICP hints. Emitted verbatim as `{ inputUrl, ... }`; the
 *      URL validation the panel enforced client-side is enforced server-side at
 *      the /resume boundary (RedditIntakePayloadSchema).
 *   2. recommendation-review — a pre-seeded `form` (CL-2773). The analyze step's
 *      keyword + subreddit recommendations are emitted as multiSelect options
 *      with defaultChecked, the search plan as a group with defaultRows, plus
 *      businessContext (textarea defaultValue) and competitors (multiSelect).
 *      The dock form now collects the review; the run-page panel is the
 *      strangler fallback.
 *   3. opportunity-selection — a `reviewList` (approvedKey "selected"). Each row
 *      carries the FULL opportunity object as its `payload` — the persist step
 *      MAPS over `selected`, one `artifact_create` per opportunity reading
 *      `title` + `content`, so the block builder guarantees a non-empty
 *      `content` (synthesizing a brief from the opportunity's fields when the
 *      curate step did not emit one).
 *
 * The collect step's per-row MAP trap (strip "r/", default sort/timeframe/limit
 * before each `reddit_subreddit_search` call) is still guarded regardless of
 * gate surface: that normalization is relocated SERVER-SIDE into the tool's
 * `normalizeSubredditSearchArgs` (CL-2769), so a panel-posted search row reaches
 * the tool complete.
 */
import {
  pendingGateForRun,
  progressStateForStepPhase,
  type DockRunInput,
  type FormField,
  type ProgressStep,
  type UIBlock,
} from "@workbench/blocks";
import {
  type AnalyzeResult,
  type Opportunity,
  parseAnalyzeOutput,
  parseCurateOutput,
  deriveBusinessContext,
} from "./parse";

/** The intake gate's `awaitSignal` name (matches the workflow def). */
export const INTAKE_SIGNAL = "intake";
/** The recommendation-review gate's `awaitSignal` name. */
export const REVIEW_SIGNAL = "recommendation-review";
/** The opportunity-selection gate's `awaitSignal` name. */
export const SELECTION_SIGNAL = "opportunity-selection";

export interface RedditOpportunityScannerBlockInput extends DockRunInput {
  /** Decoded step outputs keyed by stepId, as `stepOutputsFromLog` produces. */
  stepOutputs: Record<string, unknown>;
}

function humanizeStepId(stepId: string): string {
  return stepId.replace(/[-_]+/gu, " ").trim();
}

function runPageLink(
  runId: string,
  title: string,
  description: string,
): UIBlock {
  return { kind: "link", url: `/workflows/${runId}`, title, description };
}

function intakeForm(signalName: string): UIBlock {
  const inputUrl: FormField = {
    kind: "text",
    name: "inputUrl",
    label: "Website URL",
    placeholder: "https://example.com",
    required: true,
  };
  const brandName: FormField = {
    kind: "text",
    name: "brandName",
    label: "Brand name (optional)",
    placeholder: "Acme",
  };
  const targetGeography: FormField = {
    kind: "text",
    name: "targetGeography",
    label: "Target geography (optional)",
    placeholder: "North America",
  };
  const icpHints: FormField = {
    kind: "textarea",
    name: "icpHints",
    label: "ICP / audience hints (optional)",
    placeholder: "Who is the ideal customer? What problems do they have?",
  };
  return {
    kind: "form",
    prompt:
      "Enter the website to scan. We crawl it, infer keywords and subreddits, and let you review them before searching Reddit.",
    signalName,
    submitLabel: "Analyze site",
    fields: [inputUrl, brandName, targetGeography, icpHints],
  };
}

// The persisted brief for one opportunity. Prefer the curate step's markdown
// `content`; when it is missing, synthesize a non-empty brief from the
// opportunity's fields so the persist map's `artifact_create` never saves an
// empty document (CL-2769).
function reviewForm(signalName: string, analysis: AnalyzeResult): UIBlock {
  const kwOptions = (analysis.keywords ?? []).map((k) => ({
    value: k.label,
    label: k.label,
    ...(k.reason !== undefined ? { description: k.reason } : {}),
    defaultChecked: true,
  }));
  const subOptions = (analysis.subreddits ?? []).map((s) => {
    const clean = s.label.replace(/^r\//i, "");
    return {
      value: clean,
      label: clean,
      ...(s.reason !== undefined ? { description: s.reason } : {}),
      defaultChecked: true,
    };
  });
  const searchRows = (analysis.searches ?? []).map((s) => ({
    subreddit: s.subreddit.replace(/^r\//i, ""),
    query: s.query,
    ...(s.intent !== undefined ? { intent: s.intent } : {}),
    ...(s.reason !== undefined ? { reason: s.reason } : {}),
    sort: s.sort ?? "relevance",
    timeframe: s.timeframe ?? "month",
    limit: s.limit ?? 15,
  }));

  const keywordsField: FormField = {
    kind: "multiSelect",
    name: "keywords",
    label: "Keywords",
    required: true,
    min: 1,
    options: kwOptions,
  };
  const subredditsField: FormField = {
    kind: "multiSelect",
    name: "subreddits",
    label: "Subreddits",
    required: true,
    min: 1,
    options: subOptions,
  };
  const businessContextField: FormField = {
    kind: "textarea",
    name: "businessContext",
    label: "Business context (optional)",
    defaultValue: deriveBusinessContext(analysis),
  };
  const competitorsField: FormField = {
    kind: "multiSelect",
    name: "competitors",
    label: "Competitors (optional)",
    options: (analysis.competitors ?? []).map((c) => ({
      value: c,
      label: c,
      defaultChecked: true,
    })),
  };
  const searchesField: FormField = {
    kind: "group",
    name: "searches",
    label: "Searches",
    min: 1,
    addLabel: "Add search",
    defaultRows: searchRows,
    fields: [
      { kind: "text", name: "subreddit", label: "Subreddit", required: true },
      { kind: "text", name: "query", label: "Query", required: true },
      { kind: "text", name: "sort", label: "Sort" },
      { kind: "text", name: "timeframe", label: "Timeframe" },
      { kind: "number", name: "limit", label: "Limit" },
      { kind: "text", name: "intent", label: "Intent" },
      { kind: "text", name: "reason", label: "Reason" },
    ],
  };

  return {
    kind: "form",
    prompt:
      "Review / edit the inferred keywords, subreddits and search plan before scanning Reddit.",
    signalName,
    submitLabel: "Scan Reddit",
    fields: [
      keywordsField,
      subredditsField,
      businessContextField,
      competitorsField,
      searchesField,
    ],
  };
}

export function opportunityContent(opportunity: Opportunity): string {
  if (
    typeof opportunity.content === "string" &&
    opportunity.content.trim().length > 0
  ) {
    return opportunity.content;
  }
  const lines: (string | null)[] = [
    `# ${opportunity.title}`,
    `Subreddit: r/${opportunity.subreddit}`,
    opportunity.whyItMatters !== undefined
      ? `Why it matters: ${opportunity.whyItMatters}`
      : null,
    opportunity.evidence !== undefined
      ? `Evidence: ${opportunity.evidence}`
      : null,
    opportunity.detail !== undefined ? `Detail: ${opportunity.detail}` : null,
    opportunity.suggestedAction !== undefined
      ? `Suggested action: ${opportunity.suggestedAction}`
      : null,
    opportunity.url !== undefined ? `Thread: ${opportunity.url}` : null,
  ];
  return lines.filter((line): line is string => line !== null).join("\n\n");
}

const SIGNAL_LABELS: Record<Opportunity["signal"], string> = {
  "buying-signal": "Buying signal",
  "pain-point": "Pain point",
  "competitor-mention": "Competitor mention",
};

function selectionList(
  signalName: string,
  opportunities: Opportunity[],
): UIBlock {
  return {
    kind: "reviewList",
    title: "Select opportunities to save",
    prompt:
      "Approve the opportunities to save. Each becomes a document in your workbench.",
    signalName,
    submitLabel: "Save selected",
    approvedKey: "selected",
    min: 1,
    displayFields: [
      { key: "title", label: "Opportunity" },
      { key: "subreddit", label: "Subreddit" },
      { key: "signal", label: "Signal", kind: "badge" },
      { key: "why", label: "Why it matters" },
    ],
    rows: opportunities.map((opportunity) => ({
      id: opportunity.id,
      fields: {
        title: opportunity.title,
        subreddit: `r/${opportunity.subreddit}`,
        signal: SIGNAL_LABELS[opportunity.signal],
        why:
          opportunity.whyItMatters ??
          opportunity.detail ??
          opportunity.evidence ??
          "",
      },
      // The FULL opportunity is the row payload the persist step maps over, with
      // a guaranteed non-empty content brief.
      payload: { ...opportunity, content: opportunityContent(opportunity) },
    })),
  };
}

export function buildRedditOpportunityScannerBlocks(
  input: RedditOpportunityScannerBlockInput,
): UIBlock[] {
  const blocks: UIBlock[] = [];

  if (input.steps.length > 0) {
    const steps: ProgressStep[] = input.steps.map((step) => ({
      state: progressStateForStepPhase(step.phase),
      label: humanizeStepId(step.stepId),
    }));
    blocks.push({ kind: "progress", steps });
  }

  const gate = pendingGateForRun({ runId: input.runId, steps: input.steps });
  if (gate !== null) {
    if (gate.signalName === INTAKE_SIGNAL) {
      blocks.push(intakeForm(gate.signalName));
    } else if (gate.signalName === REVIEW_SIGNAL) {
      const analysis = parseAnalyzeOutput(input.stepOutputs["analyze"]);
      if (analysis !== "pending" && analysis !== "error") {
        blocks.push(reviewForm(gate.signalName, analysis));
      } else {
        blocks.push(
          runPageLink(
            input.runId,
            "Review the search plan on the run page",
            "Review the inferred keywords, subreddits, and search plan on the run page before scanning Reddit.",
          ),
        );
      }
    } else if (gate.signalName === SELECTION_SIGNAL) {
      const curated = parseCurateOutput(input.stepOutputs["curate"]);
      const opportunities = Array.isArray(curated) ? curated : [];
      if (opportunities.length > 0) {
        blocks.push(selectionList(gate.signalName, opportunities));
      } else {
        blocks.push(
          runPageLink(
            input.runId,
            "Review opportunities on the run page",
            "The ranked opportunities aren't available here yet — review and select them on the run page.",
          ),
        );
      }
    } else {
      blocks.push(
        runPageLink(
          input.runId,
          "Continue on the run page",
          "This run needs input the dock can't collect yet — continue on the run page.",
        ),
      );
    }
  }

  if (input.phase === "failed" && input.errorMessage !== undefined) {
    blocks.push({ kind: "error", message: input.errorMessage });
  }

  if (input.phase === "completed" && input.completedLink !== undefined) {
    blocks.push({
      kind: "link",
      url: input.completedLink.url,
      title: input.completedLink.title,
      ...(input.completedLink.description !== undefined
        ? { description: input.completedLink.description }
        : {}),
    });
  }

  return blocks;
}
