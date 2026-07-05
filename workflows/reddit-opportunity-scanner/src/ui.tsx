import { useState } from "react";
import { type } from "arktype";
import type { RunState, StepState } from "@intx/workflow";
import {
  activeDisplayStep,
  buildRunStepperSteps,
  Button,
  type DisplayStep,
  failedRunErrorMessage,
  HorizontalStepper,
  LiveStatusSlot,
  liveStatusLabel,
  Markdown,
  type WorkflowPanelProps,
  type WorkflowStep,
} from "@workbench/ui";
import {
  type AnalyzeResult,
  deriveBusinessContext,
  type Opportunity,
  parseAnalyzeOutput,
  parseCurateOutput,
  type SearchPlanItem,
} from "./parse";

export type { AnalyzeResult, Opportunity };

// ── Step order + labels ───────────────────────────────────────────────────────

const STEP_ORDER = [
  "intake",
  "scrape",
  "analyze",
  "review",
  "collect",
  "curate",
  "selection",
  "persist",
] as const;
type StepKey = (typeof STEP_ORDER)[number];

const STEP_LABELS: Record<StepKey, string> = {
  intake: "Website",
  scrape: "Crawl",
  analyze: "Strategy",
  review: "Search plan",
  collect: "Collect",
  curate: "Opportunities",
  selection: "Select",
  persist: "Done",
};

const INTAKE_SIGNAL = "intake";
const REVIEW_SIGNAL = "recommendation-review";
const SELECTION_SIGNAL = "opportunity-selection";

// ── Output schemas ──────────────────────────────────────────────────────────────

// deterministicToolStep output: { callId: string, content: "<JSON>" }
const ToolResultEnvelope = type({ callId: "string", content: "string" });

const PersistContent = type({
  "artifactId?": "string",
  "title?": "string",
  "kind?": "string",
  "version?": "number",
});

// ── Phase helpers ──────────────────────────────────────────────────────────────

type StepPhase = StepState["phase"];

function phaseFor(
  state: RunState | null,
  stepId: StepKey,
): StepPhase | undefined {
  return state?.steps.get(stepId)?.phase;
}

// One runtime step per display step; the shared helpers encode the robust
// "passed = completed OR a later step progressed" rule so a gate whose output is
// missing from the synthesized record can't rewind the panel mid-run (CL-2506).
// Machine-work steps carry a verb `activityLabel` for the live line; the intake,
// review, and selection gates carry none.
const STEP_ACTIVITY: Partial<Record<StepKey, string>> = {
  scrape: "Reading the website",
  analyze: "Building the search plan",
  collect: "Searching Reddit",
  curate: "Curating opportunities",
  persist: "Saving to workbench",
};

const DISPLAY_STEPS: DisplayStep[] = STEP_ORDER.map((id) => ({
  key: id,
  label: STEP_LABELS[id],
  stepIds: [id],
  ...(STEP_ACTIVITY[id] !== undefined
    ? { activityLabel: STEP_ACTIVITY[id] }
    : {}),
}));

function buildStepperSteps(state: RunState | null): WorkflowStep[] {
  return buildRunStepperSteps(state, DISPLAY_STEPS);
}

function activeStep(state: RunState | null): StepKey {
  return activeDisplayStep(state, DISPLAY_STEPS)?.key as StepKey;
}

// ── Shared primitives ──────────────────────────────────────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return <section className="bg-surface p-6">{children}</section>;
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-4 text-sm font-semibold text-text">{children}</h3>;
}

function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-text-3">
      <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-border border-t-text-3" />
      {label ?? "Working…"}
    </div>
  );
}

function ErrorCard({
  title,
  detail,
  onClose,
}: {
  title: string;
  detail?: string;
  onClose?: () => void;
}) {
  return (
    <Card>
      <p className="text-sm font-medium text-orange">{title}</p>
      {detail !== undefined ? (
        <p className="mt-1 text-xs text-text-3">{detail}</p>
      ) : null}
      {onClose !== undefined ? (
        <div className="mt-5">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Start over
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

// ── Chip input ──────────────────────────────────────────────────────────────────

function ChipInput({
  id,
  label,
  hint,
  placeholder,
  items,
  onAdd,
  onRemove,
}: {
  id: string;
  label: string;
  hint?: string;
  placeholder: string;
  items: string[];
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
}) {
  const [draft, setDraft] = useState("");

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) return;
    if (!items.includes(trimmed)) onAdd(trimmed);
    setDraft("");
  };

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium text-text">
        {label}
        {hint !== undefined ? (
          <span className="ml-1 text-text-3"> {hint}</span>
        ) : null}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit();
            }
          }}
          placeholder={placeholder}
          className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange"
        />
        <Button type="button" variant="ghost" size="sm" onClick={commit}>
          Add
        </Button>
      </div>
      {items.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {items.map((item) => (
            <span
              key={item}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2.5 py-0.5 text-xs text-text-2"
            >
              {item}
              <button
                type="button"
                aria-label={`Remove ${item}`}
                onClick={() => onRemove(item)}
                className="ml-0.5 text-text-3 hover:text-text"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── Screen: Intake (website URL + optional hints) ───────────────────────────────

export type IntakePayload = {
  inputUrl: string;
  brandName?: string;
  targetGeography?: string;
  icpHints?: string;
};

function IntakeScreen({
  phase,
  connected,
  signalPending,
  onSubmit,
}: {
  phase: StepPhase | undefined;
  connected: boolean;
  signalPending: boolean;
  onSubmit: (payload: IntakePayload) => void;
}) {
  const [inputUrl, setInputUrl] = useState("");
  const [brandName, setBrandName] = useState("");
  const [targetGeography, setTargetGeography] = useState("");
  const [icpHints, setIcpHints] = useState("");

  const urlValid = /^https?:\/\/.+/i.test(inputUrl.trim());
  const canSubmit = connected && !signalPending && urlValid;

  if (phase !== "awaiting-signal") {
    return (
      <Card>
        <CardTitle>Getting ready</CardTitle>
        <Spinner label="Preparing the website form…" />
      </Card>
    );
  }

  const optional = (value: string): string | undefined => {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  return (
    <Card>
      <CardTitle>What should we analyze?</CardTitle>
      <p className="mb-5 text-xs text-text-3">
        Enter the website to scan. We crawl it, infer keywords and subreddits,
        and let you review them before searching Reddit.
      </p>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          const brand = optional(brandName);
          const geo = optional(targetGeography);
          const icp = optional(icpHints);
          onSubmit({
            inputUrl: inputUrl.trim(),
            ...(brand !== undefined ? { brandName: brand } : {}),
            ...(geo !== undefined ? { targetGeography: geo } : {}),
            ...(icp !== undefined ? { icpHints: icp } : {}),
          });
        }}
      >
        <Field id="intake-url" label="Website URL" required>
          <input
            id="intake-url"
            type="url"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            placeholder="https://example.com"
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange"
          />
        </Field>
        <Field id="intake-brand" label="Brand name" hint="(optional)">
          <input
            id="intake-brand"
            type="text"
            value={brandName}
            onChange={(e) => setBrandName(e.target.value)}
            placeholder="Acme"
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange"
          />
        </Field>
        <Field id="intake-geo" label="Target geography" hint="(optional)">
          <input
            id="intake-geo"
            type="text"
            value={targetGeography}
            onChange={(e) => setTargetGeography(e.target.value)}
            placeholder="North America"
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange"
          />
        </Field>
        <Field id="intake-icp" label="ICP / audience hints" hint="(optional)">
          <textarea
            id="intake-icp"
            value={icpHints}
            onChange={(e) => setIcpHints(e.target.value)}
            placeholder="Who is the ideal customer? What problems do they have?"
            rows={3}
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange"
          />
        </Field>
        <div className="flex items-center gap-3 pt-1">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!canSubmit}
          >
            Analyze site
          </Button>
          {!connected ? (
            <p className="text-xs text-text-3">
              Reconnecting — input unavailable.
            </p>
          ) : null}
          {connected && inputUrl.trim().length > 0 && !urlValid ? (
            <p className="text-xs text-orange">
              Enter a URL that starts with http:// or https://
            </p>
          ) : null}
          {connected && signalPending ? <Spinner label="Submitting…" /> : null}
        </div>
      </form>
    </Card>
  );
}

function Field({
  id,
  label,
  hint,
  required,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium text-text">
        {label}
        {required === true ? (
          <span className="ml-0.5 text-orange">*</span>
        ) : null}
        {hint !== undefined ? (
          <span className="ml-1 text-text-3"> {hint}</span>
        ) : null}
      </label>
      {children}
    </div>
  );
}

// ── Screen: Scrape (deterministic, progress only) ───────────────────────────────

function ScrapeScreen({
  phase,
  onClose,
}: {
  phase: StepPhase | undefined;
  onClose: () => void;
}) {
  if (phase === "failed" || phase === "cancelled") {
    return (
      <ErrorCard
        title="Couldn't crawl the site."
        detail="We couldn't read the website. Start over with a different URL."
        onClose={onClose}
      />
    );
  }
  return (
    <Card>
      <CardTitle>Crawling the site</CardTitle>
      <Spinner label="Fetching the page content…" />
    </Card>
  );
}

// ── Screen: Analyze + Review (recommendations) ──────────────────────────────────

function RecommendationReview({
  phase,
  connected,
  signalPending,
  analyzeOutput,
  onSubmit,
  onClose,
}: {
  phase: StepPhase | undefined;
  connected: boolean;
  signalPending: boolean;
  analyzeOutput: unknown;
  onSubmit: (payload: {
    keywords: string[];
    subreddits: string[];
    competitors: string[];
    businessContext: string;
    searches: SearchPlanItem[];
  }) => void;
  onClose: () => void;
}) {
  const analysis = parseAnalyzeOutput(analyzeOutput);

  if (analysis === "pending") {
    return (
      <Card>
        <CardTitle>Analyzing the site</CardTitle>
        <Spinner label="Inferring keywords and subreddits…" />
      </Card>
    );
  }

  if (analysis === "error") {
    return (
      <ErrorCard
        title="Couldn't read the analysis."
        detail="We couldn't read the results. Start a new run."
        onClose={onClose}
      />
    );
  }

  if (phase !== "awaiting-signal") {
    return (
      <Card>
        <CardTitle>Building the search plan</CardTitle>
        <Spinner label="Preparing the recommendations…" />
      </Card>
    );
  }

  // Mount the editable form only once the analysis is parsed and the gate is
  // open, so its initial chip state is seeded from the real recommendations.
  return (
    <RecommendationForm
      analysis={analysis}
      connected={connected}
      signalPending={signalPending}
      onSubmit={onSubmit}
    />
  );
}

function RecommendationForm({
  analysis,
  connected,
  signalPending,
  onSubmit,
}: {
  analysis: AnalyzeResult;
  connected: boolean;
  signalPending: boolean;
  onSubmit: (payload: {
    keywords: string[];
    subreddits: string[];
    competitors: string[];
    businessContext: string;
    searches: SearchPlanItem[];
  }) => void;
}) {
  const [keywords, setKeywords] = useState<string[]>(() =>
    (analysis.keywords ?? []).map((k) => k.label),
  );
  const [subreddits, setSubreddits] = useState<string[]>(() =>
    (analysis.subreddits ?? []).map((s) => s.label.replace(/^r\//i, "")),
  );
  const [searches, setSearches] = useState<SearchPlanItem[]>(() =>
    (analysis.searches ?? []).map((search) => ({
      ...search,
      subreddit: search.subreddit.replace(/^r\//i, ""),
      sort: search.sort ?? "relevance",
      timeframe: search.timeframe ?? "month",
      limit: search.limit ?? 15,
    })),
  );

  const updateSearch = (index: number, patch: Partial<SearchPlanItem>) =>
    setSearches((prev) =>
      prev.map((search, i) => (i === index ? { ...search, ...patch } : search)),
    );
  const removeSearch = (index: number) =>
    setSearches((prev) => prev.filter((_, i) => i !== index));
  const addSearch = () =>
    setSearches((prev) => [
      ...prev,
      {
        subreddit: "",
        query: "",
        sort: "relevance",
        timeframe: "month",
        limit: 15,
      },
    ]);

  const competitors = analysis.competitors ?? [];
  const businessContext = deriveBusinessContext(analysis);

  const validSearches = searches
    .filter(
      (search) =>
        search.subreddit.trim().length > 0 && search.query.trim().length > 0,
    )
    .map((search) => ({
      ...search,
      subreddit: search.subreddit.trim().replace(/^r\//i, ""),
      query: search.query.trim(),
    }));
  const canSubmit =
    connected &&
    !signalPending &&
    keywords.length > 0 &&
    subreddits.length > 0 &&
    validSearches.length > 0;

  return (
    <Card>
      <CardTitle>Review keywords and subreddits</CardTitle>
      {analysis.whatTheySell !== undefined ? (
        <div className="mb-5 rounded-lg border border-border bg-surface-2 p-3 text-xs text-text-2">
          <Markdown>{businessContext}</Markdown>
        </div>
      ) : null}
      <p className="mb-5 text-xs text-text-3">
        We inferred these from the site. Add, remove, or edit them before
        scanning Reddit.
      </p>
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          onSubmit({
            keywords,
            subreddits,
            competitors,
            businessContext,
            searches: validSearches,
          });
        }}
      >
        <ChipInput
          id="review-keywords"
          label="Keywords"
          placeholder="e.g. observability"
          items={keywords}
          onAdd={(v) => setKeywords((prev) => [...prev, v])}
          onRemove={(v) => setKeywords((prev) => prev.filter((k) => k !== v))}
        />
        <ChipInput
          id="review-subreddits"
          label="Subreddits"
          hint="(without r/)"
          placeholder="e.g. devops"
          items={subreddits}
          onAdd={(v) =>
            setSubreddits((prev) => [...prev, v.replace(/^r\//i, "")])
          }
          onRemove={(v) => setSubreddits((prev) => prev.filter((s) => s !== v))}
        />
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-text">Search plan</p>
            <p className="text-xs text-text-3">
              {validSearches.length}{" "}
              {validSearches.length === 1 ? "search" : "searches"}
            </p>
          </div>
          <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-border bg-surface-2 p-2">
            {searches.length === 0 ? (
              <p className="px-1 py-1.5 text-xs text-text-3">
                No searches yet. Add one to scan Reddit.
              </p>
            ) : (
              searches.map((search, index) => (
                <div
                  key={index}
                  className="flex items-center gap-2 rounded-md bg-bg px-2 py-1.5"
                >
                  <span className="shrink-0 text-xs text-text-3">r/</span>
                  <input
                    type="text"
                    aria-label={`Subreddit for search ${index + 1}`}
                    value={search.subreddit}
                    onChange={(e) =>
                      updateSearch(index, { subreddit: e.target.value })
                    }
                    placeholder="subreddit"
                    className="w-28 min-w-0 rounded border border-border bg-bg px-2 py-1 text-xs text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange"
                  />
                  <input
                    type="text"
                    aria-label={`Query for search ${index + 1}`}
                    value={search.query}
                    onChange={(e) =>
                      updateSearch(index, { query: e.target.value })
                    }
                    placeholder="search query"
                    className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-xs text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange"
                  />
                  <button
                    type="button"
                    aria-label={`Remove search ${index + 1}`}
                    onClick={() => removeSearch(index)}
                    className="shrink-0 text-text-3 hover:text-text"
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={addSearch}>
            Add search
          </Button>
        </div>
        <div className="flex items-center gap-3 pt-1">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!canSubmit}
          >
            Scan Reddit
          </Button>
          {!connected ? (
            <p className="text-xs text-text-3">
              Reconnecting — action unavailable.
            </p>
          ) : null}
          {connected && signalPending ? <Spinner label="Submitting…" /> : null}
        </div>
      </form>
    </Card>
  );
}

// ── Opportunity card + badge ────────────────────────────────────────────────────

function SignalBadge({ signal }: { signal: Opportunity["signal"] }) {
  const MAP = {
    "buying-signal": {
      label: "Buying signal",
      className: "bg-green/10 text-green",
    },
    "pain-point": {
      label: "Pain point",
      className: "bg-orange/10 text-orange",
    },
    "competitor-mention": {
      label: "Competitor",
      className: "bg-surface-2 text-text-2 border border-border",
    },
  } as const;
  const cfg = MAP[signal];
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${cfg.className}`}
    >
      {cfg.label}
    </span>
  );
}

function OpportunityCard({
  opportunity,
  selected,
  onToggle,
}: {
  opportunity: Opportunity;
  selected?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div
      className={`rounded-lg border bg-surface-2 p-3 ${
        selected === true ? "border-orange" : "border-border"
      } ${onToggle !== undefined ? "cursor-pointer transition-colors hover:border-border-strong" : ""}`}
      onClick={onToggle}
      role={onToggle !== undefined ? "checkbox" : undefined}
      aria-checked={selected}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text">
            {opportunity.title}
          </p>
          <p className="mt-0.5 font-mono text-xs text-text-3">
            r/{opportunity.subreddit}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SignalBadge signal={opportunity.signal} />
          {onToggle !== undefined ? (
            <div
              className={`h-4 w-4 rounded border ${
                selected === true
                  ? "border-orange bg-orange"
                  : "border-border bg-bg"
              } flex items-center justify-center`}
            >
              {selected === true ? (
                <svg
                  className="h-2.5 w-2.5 text-white"
                  viewBox="0 0 10 10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M1.5 5l2.5 2.5 4.5-4.5" />
                </svg>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <p className="mt-1.5 text-xs text-text-2">
        {opportunity.whyItMatters ?? opportunity.detail ?? opportunity.evidence}
      </p>
      {opportunity.suggestedAction !== undefined ? (
        <p className="mt-1 text-xs text-text-3">
          Next: {opportunity.suggestedAction}
        </p>
      ) : null}
      {opportunity.url !== undefined ? (
        <a
          href={opportunity.url}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-xs text-orange hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          Open thread
        </a>
      ) : null}
    </div>
  );
}

// ── Screen: Collect + curate progress ───────────────────────────────────────────

function CollectScreen({
  phase,
  onClose,
}: {
  phase: StepPhase | undefined;
  onClose: () => void;
}) {
  if (phase === "failed" || phase === "cancelled") {
    return (
      <ErrorCard
        title="Couldn't collect Reddit results."
        detail="Something went wrong while searching Reddit. Start over."
        onClose={onClose}
      />
    );
  }
  return (
    <Card>
      <CardTitle>Collecting Reddit evidence</CardTitle>
      <Spinner label="Searching approved subreddits and gathering candidate threads…" />
    </Card>
  );
}

function CurateScreen({
  phase,
  output,
  onClose,
}: {
  phase: StepPhase | undefined;
  output: unknown;
  onClose: () => void;
}) {
  if (phase === "in-flight" || phase === undefined) {
    return (
      <Card>
        <CardTitle>Ranking opportunities</CardTitle>
        <Spinner label="Dropping noise and scoring the strongest Reddit signals…" />
      </Card>
    );
  }

  const result = parseCurateOutput(output);

  if (result === "error") {
    return (
      <ErrorCard
        title="Couldn't read the opportunity ranking."
        detail="We couldn't read the results. Start a new run."
        onClose={onClose}
      />
    );
  }

  if (result === "pending") {
    return (
      <Card>
        <CardTitle>Ranking opportunities</CardTitle>
        <Spinner />
      </Card>
    );
  }

  return (
    <Card>
      <CardTitle>{result.length} opportunities found</CardTitle>
      {result.length > 0 ? (
        <div className="space-y-2">
          {result.map((opp) => (
            <OpportunityCard key={opp.id} opportunity={opp} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-text-3">No strong opportunities found.</p>
      )}
    </Card>
  );
}

// ── Screen: Selection (pick opportunities to persist) ───────────────────────────

function SelectionScreen({
  phase,
  connected,
  signalPending,
  curateOutput,
  onSubmit,
  onClose,
}: {
  phase: StepPhase | undefined;
  connected: boolean;
  signalPending: boolean;
  curateOutput: unknown;
  onSubmit: (payload: { selected: Opportunity[] }) => void;
  onClose: () => void;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const result = parseCurateOutput(curateOutput);
  const opportunities = Array.isArray(result) ? result : [];

  const canSubmit = connected && !signalPending && selectedIds.size > 0;

  const toggleId = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  if (phase !== "awaiting-signal") {
    return (
      <Card>
        <CardTitle>Preparing opportunities</CardTitle>
        <Spinner label="Getting the results ready to review…" />
      </Card>
    );
  }

  if (opportunities.length === 0) {
    return (
      <ErrorCard
        title="No opportunities to review."
        detail="We didn't find any strong opportunities. Start over with different keywords or subreddits."
        onClose={onClose}
      />
    );
  }

  const selectedOpportunities = opportunities.filter((o) =>
    selectedIds.has(o.id),
  );

  return (
    <Card>
      <CardTitle>Select opportunities to save</CardTitle>
      <p className="mb-4 text-xs text-text-3">
        Choose which opportunities to save. Each becomes a document in your
        workbench.
      </p>
      <div className="space-y-2">
        {opportunities.map((opp) => (
          <OpportunityCard
            key={opp.id}
            opportunity={opp}
            selected={selectedIds.has(opp.id)}
            onToggle={() => toggleId(opp.id)}
          />
        ))}
      </div>
      <div className="mt-5 flex items-center gap-3">
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={!canSubmit}
          onClick={() => {
            if (!canSubmit) return;
            onSubmit({ selected: selectedOpportunities });
          }}
        >
          Save {selectedIds.size > 0 ? `${selectedIds.size} ` : ""}
          {selectedIds.size === 1 ? "opportunity" : "opportunities"}
        </Button>
        {!connected ? (
          <p className="text-xs text-text-3">
            Reconnecting — action unavailable.
          </p>
        ) : null}
        {connected && signalPending ? <Spinner label="Submitting…" /> : null}
      </div>
    </Card>
  );
}

// ── Screen: Persist ─────────────────────────────────────────────────────────────

function readPersistedArtifact(
  raw: unknown,
): { artifactId?: string; title?: string; kind?: string } | undefined {
  const envelope = ToolResultEnvelope(raw);
  if (envelope instanceof type.errors) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(envelope.content);
  } catch {
    return undefined;
  }
  const parsed = PersistContent(decoded);
  if (parsed instanceof type.errors) return undefined;
  return {
    ...(parsed.artifactId !== undefined
      ? { artifactId: parsed.artifactId }
      : {}),
    ...(parsed.title !== undefined ? { title: parsed.title } : {}),
    ...(parsed.kind !== undefined ? { kind: parsed.kind } : {}),
  };
}

function PersistScreen({
  phase,
  output,
  onClose,
}: {
  phase: StepPhase | undefined;
  output: unknown;
  onClose: () => void;
}) {
  if (phase === "in-flight" || phase === undefined) {
    return (
      <Card>
        <CardTitle>Saving documents</CardTitle>
        <Spinner />
      </Card>
    );
  }

  // `persist` is a `map` — its output is an array of tool-result envelopes,
  // one per selected opportunity. `items.length` is what we tried to save;
  // `documents.length` is what actually came back.
  const items = Array.isArray(output) ? output : [];
  const documents = items
    .map(readPersistedArtifact)
    .filter((a): a is NonNullable<typeof a> => a !== undefined);

  const savedCount = documents.length;
  const attemptedCount = items.length;

  if (savedCount === 0) {
    return (
      <Card>
        <CardTitle>Couldn't save your opportunities</CardTitle>
        <p className="text-sm text-text-3">
          Nothing was saved. Start a new run and try again.
        </p>
        <div className="mt-5">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </Card>
    );
  }

  const partial = attemptedCount > savedCount;
  const heading = partial
    ? `Saved ${savedCount} of ${attemptedCount} documents`
    : `Done — ${savedCount} document${savedCount === 1 ? "" : "s"} saved`;

  return (
    <Card>
      <CardTitle>{heading}</CardTitle>
      {partial ? (
        <p className="mb-3 text-xs text-text-3">
          Some opportunities couldn&apos;t be saved.
        </p>
      ) : null}
      <div className="space-y-2">
        {documents.map((document, index) => (
          <div
            key={document.artifactId ?? index}
            className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2"
          >
            <span className="min-w-0 truncate text-sm text-text">
              {document.title ?? document.artifactId ?? "Saved document"}
            </span>
            {document.kind !== undefined ? (
              <span className="shrink-0 text-xs text-text-3">
                {document.kind}
              </span>
            ) : null}
          </div>
        ))}
      </div>
      <div className="mt-5">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </Card>
  );
}

// ── Root Panel ──────────────────────────────────────────────────────────────────

export function Panel(props: WorkflowPanelProps) {
  const { state, connected, signalPending, stepOutputs, onSignal, onClose } =
    props;

  const active = activeStep(state);
  const runPhase = state?.phase;
  const failed = runPhase === "failed" || runPhase === "cancelled";
  // `failed` also covers `cancelled`, which liveStatusLabel does not suppress.
  const liveLabel = failed ? null : liveStatusLabel(state, DISPLAY_STEPS);

  const failError = failedRunErrorMessage(state) ?? undefined;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-5 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text">
            Reddit Opportunity Scanner
          </p>
          <p className="mt-px font-mono text-[11px] text-text-3">
            {connected ? "Live" : "Reconnecting"}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid h-7 w-7 place-items-center rounded-lg border border-border text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="h-4 w-4"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <HorizontalStepper steps={buildStepperSteps(state)} />
      <LiveStatusSlot label={liveLabel} />

      {/* Body — guided: only the active step screen is rendered */}
      <div className="flex-1 overflow-y-auto p-5">
        {failed ? (
          <ErrorCard
            title="This run failed."
            detail={failError ?? "Review the step details and start over."}
            onClose={onClose}
          />
        ) : active === "intake" ? (
          <IntakeScreen
            phase={phaseFor(state, "intake")}
            connected={connected}
            signalPending={signalPending}
            onSubmit={(payload) => onSignal(INTAKE_SIGNAL, payload)}
          />
        ) : active === "scrape" ? (
          <ScrapeScreen phase={phaseFor(state, "scrape")} onClose={onClose} />
        ) : active === "analyze" || active === "review" ? (
          <RecommendationReview
            phase={phaseFor(state, "review")}
            connected={connected}
            signalPending={signalPending}
            analyzeOutput={stepOutputs["analyze"]}
            onSubmit={(payload) => onSignal(REVIEW_SIGNAL, payload)}
            onClose={onClose}
          />
        ) : active === "collect" ? (
          <CollectScreen phase={phaseFor(state, "collect")} onClose={onClose} />
        ) : active === "curate" ? (
          <CurateScreen
            phase={phaseFor(state, "curate")}
            output={stepOutputs["curate"]}
            onClose={onClose}
          />
        ) : active === "selection" ? (
          <SelectionScreen
            phase={phaseFor(state, "selection")}
            connected={connected}
            signalPending={signalPending}
            curateOutput={stepOutputs["curate"]}
            onSubmit={(payload) => onSignal(SELECTION_SIGNAL, payload)}
            onClose={onClose}
          />
        ) : active === "persist" ? (
          <PersistScreen
            phase={phaseFor(state, "persist")}
            output={stepOutputs["persist"]}
            onClose={onClose}
          />
        ) : (
          <Card>
            <CardTitle>Loading…</CardTitle>
            <Spinner />
          </Card>
        )}
      </div>
    </div>
  );
}
