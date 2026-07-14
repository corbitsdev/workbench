import { useState } from "react";
import { type } from "arktype";
import type { RunState, StepState } from "@intx/workflow";
import {
  activeDisplayStep,
  buildRunStepperSteps,
  Button,
  FailedRunNotice,
  HorizontalStepper,
  LiveStatusSlot,
  Markdown,
  type WorkflowPanelProps,
  type WorkflowStep,
  workflowPanelShowsShellHeader,
} from "@workbench/ui";
import { parseReport, type Report } from "@workbench/last30days-core";
import { DISPLAY_STEPS, RESEARCH_STEP_IDS } from "./display-steps";

const INTAKE_SIGNAL = "intake";

type StepKey = "intake" | "research" | "report" | "done";

// The research-phase step ids and the display flow (order, labels, grouping) are
// declared once in the browser-safe ./display-steps module and shared with the
// server catalog preview. Routing goes through the shared helpers; the live LINE
// is bespoke (see `currentActivity`), so the declaration carries no
// `activityLabel`.

const ToolResultEnvelope = type({ callId: "string", content: "string" }).or({
  content: "string",
});
const AgentStepOutput = type({ reply: "string", "turn?": "unknown" });
const PersistContent = type({
  "artifactId?": "string",
  "title?": "string",
  "kind?": "string",
  "version?": "number",
});

type StepPhase = StepState["phase"];

function phaseFor(
  state: RunState | null,
  stepId: string,
): StepPhase | undefined {
  return state?.steps.get(stepId)?.phase;
}

function researchPhase(state: RunState | null): StepPhase | undefined {
  if (phaseFor(state, "brief") === "completed") return "completed";
  for (const id of RESEARCH_STEP_IDS) {
    const p = phaseFor(state, id);
    if (p === "in-flight" || p === "awaiting-signal" || p === "awaiting-timer")
      return p;
    if (p === "failed") return "failed";
  }
  if (phaseFor(state, "intake") === "completed") return "in-flight";
  return undefined;
}

// The intake awaitSignal gate's StepCompleted can be absent from the synthesized
// record (projection lag / an unresolved output ref), so its own phase is an
// unreliable "done" signal. Any downstream progress proves the gate cleared —
// without this the panel regresses to the "Setting up workflow" intake screen
// mid-run (CL-2505).
function intakeIsDone(state: RunState | null): boolean {
  if (phaseFor(state, "intake") === "completed") return true;
  return researchPhase(state) !== undefined;
}

function buildStepperSteps(state: RunState | null): WorkflowStep[] {
  return buildRunStepperSteps(state, DISPLAY_STEPS);
}

// Routed through the shared "passed = completed OR a later step progressed"
// rule, which preserves the old intakeIsDone fix: if the intake gate's output
// is absent from the synthesized record but a research step has progressed, the
// run stays on Research instead of rewinding to the Topic screen (CL-2506).
function activeStep(state: RunState | null): StepKey {
  return activeDisplayStep(state, DISPLAY_STEPS)?.key as StepKey;
}

function parseBriefReport(
  raw: unknown,
): ReturnType<typeof parseReport> | "pending" | "error" {
  const envelope = ToolResultEnvelope(raw);
  if (envelope instanceof type.errors) return "pending";
  try {
    const decoded: unknown = JSON.parse(envelope.content);
    const report = parseReport(decoded);
    return report ?? "error";
  } catch {
    return "error";
  }
}

function parseWriteReply(raw: unknown): string | "pending" {
  const envelope = AgentStepOutput(raw);
  if (envelope instanceof type.errors) return "pending";
  return envelope.reply;
}

function Card({ children }: { children: React.ReactNode }) {
  return <section className="bg-surface p-6">{children}</section>;
}

function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-text-3">
      <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-border border-t-text-3" />
      {label ?? "Working…"}
    </div>
  );
}

const SOURCE_PROGRESS: { id: string; label: string }[] = [
  { id: "ground", label: "Tailoring queries" },
  { id: "hackernews", label: "Hacker News" },
  { id: "github", label: "GitHub" },
  { id: "web", label: "Web" },
  { id: "reddit", label: "Reddit" },
  { id: "x", label: "X" },
  { id: "youtube", label: "YouTube" },
  { id: "polymarket", label: "Polymarket" },
  { id: "entities", label: "Chasing entities" },
  { id: "web2", label: "Deeper web" },
  { id: "reddit2", label: "Deeper Reddit" },
  { id: "x2", label: "Deeper X" },
  { id: "youtube2", label: "Deeper YouTube" },
  { id: "curate", label: "Curating themes" },
  { id: "brief", label: "Building brief" },
];

function isRunningPhase(phase: StepPhase | undefined): boolean {
  return (
    phase === "in-flight" ||
    phase === "awaiting-signal" ||
    phase === "awaiting-timer"
  );
}

function sourceStatusLabel(phase: StepPhase | undefined): {
  text: string;
  tone: string;
} {
  if (phase === "completed") return { text: "done", tone: "text-green" };
  if (phase === "failed") return { text: "skipped", tone: "text-text-3" };
  // Summit Blue for in-progress (cool, informational); orange is reserved for
  // the single primary action on screen ("Start research").
  if (isRunningPhase(phase)) return { text: "running", tone: "text-blue" };
  return { text: "waiting", tone: "text-text-3" };
}

// The single "Tailoring queries" row stands in for both the grounding inference
// (`ground`) and the deterministic parse (`groundQueries`); it stays "running"
// across both so the panel never shows an all-idle gap while the fast parse step
// runs, and reads "done" only once the per-source query map exists.
function rowPhase(state: RunState | null, id: string): StepPhase | undefined {
  if (id !== "ground") return phaseFor(state, id);
  const parse = phaseFor(state, "groundQueries");
  if (parse === "completed") return "completed";
  if (isRunningPhase(parse)) return parse;
  if (phaseFor(state, "ground") === "completed") return "in-flight";
  return phaseFor(state, "ground");
}

// Verb phrasing for the live status line, for the stable bare-source rows whose
// SOURCE_PROGRESS label is just a platform name ("GitHub"). Every other row
// (grounding, deeper passes, curation, brief) already carries a descriptive
// label, so the line falls back to that — no parallel map to drift as the
// research pipeline gains stages (CL-2505).
const SEARCH_VERB: Record<string, string> = {
  hackernews: "Searching Hacker News",
  github: "Searching GitHub",
  web: "Searching the web",
  reddit: "Searching Reddit",
  x: "Searching X",
  youtube: "Searching YouTube",
  polymarket: "Checking Polymarket odds",
};

// The single live line that tells the user what the run is doing right now.
// Returns null while the intake screen is up (it carries its own indicator) and
// on terminal runs. Poll-driven: it advances each ~2s record refetch.
function currentActivity(state: RunState | null): string | null {
  if (state === null) return null;
  if (state.phase === "failed" || state.phase === "completed") return null;
  if (!intakeIsDone(state)) return null;
  const researchDone = researchPhase(state) === "completed";
  if (!researchDone) {
    const running = SOURCE_PROGRESS.find(({ id }) =>
      isRunningPhase(rowPhase(state, id)),
    );
    if (running === undefined) return "Gathering signal";
    return SEARCH_VERB[running.id] ?? running.label;
  }
  if (phaseFor(state, "write") === "completed") {
    if (phaseFor(state, "persist") === "completed") return null;
    return "Saving to workbench";
  }
  return "Writing the report";
}

function BriefSummary({ report }: { report: Report }) {
  const skipped = report.skippedSources?.length ?? 0;
  const summary = `${report.stats.sourceCount} sources · ${report.stats.itemCount} signals · ${report.citations.length} citations`;
  return (
    <Card>
      <h3 className="mb-1 text-sm font-semibold text-text">
        Research complete
      </h3>
      <p className="text-sm text-text-2">{summary}</p>
      {skipped > 0 ? (
        <p className="mt-1 text-xs text-text-3">
          {skipped} source{skipped === 1 ? "" : "s"} skipped
        </p>
      ) : null}
    </Card>
  );
}

function SourceProgress({ state }: { state: RunState | null }) {
  return (
    <Card>
      <h3 className="mb-4 text-sm font-semibold text-text">
        Research progress
      </h3>
      <ul className="space-y-2.5">
        {SOURCE_PROGRESS.map(({ id, label }) => {
          const phase = rowPhase(state, id);
          const status = sourceStatusLabel(phase);
          const running = isRunningPhase(phase);
          return (
            <li
              key={id}
              className="flex items-center justify-between gap-3 text-sm"
            >
              <span className="flex items-center gap-2 text-text-2">
                <span
                  className={`h-3 w-3 rounded-full border-2 transition-opacity duration-200 ${
                    running
                      ? "animate-spin border-border border-t-blue opacity-100"
                      : "border-transparent opacity-0"
                  }`}
                />
                {label}
              </span>
              <span
                className={`text-xs transition-colors duration-200 ${status.tone}`}
              >
                {status.text}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** `query` is the string every source search uses (focus text when set, else topic). */
export type IntakePayload = { topic: string; query: string; days?: number };

function IntakeScreen({
  phase,
  connected,
  signalPending,
  intakeDone,
  onSubmit,
}: {
  phase: StepPhase | undefined;
  connected: boolean;
  signalPending: boolean;
  intakeDone: boolean;
  onSubmit: (payload: IntakePayload) => void;
}) {
  const [topic, setTopic] = useState("");
  const [focus, setFocus] = useState("");

  const canSubmit = connected && !signalPending && topic.trim().length > 0;

  if (phase !== "awaiting-signal") {
    // The gate has either been submitted (signalPending) or already cleared and
    // the run is advancing (intakeDone) — show an honest live working state, not
    // the "Setting up workflow" pre-gate copy that reads as dead mid-run. Only a
    // genuinely pre-gate run (still provisioning, nothing submitted) sees "Setting
    // up workflow".
    const advancing = signalPending || intakeDone;
    return (
      <Card>
        <Spinner
          label={advancing ? "Starting research…" : "Setting up workflow…"}
        />
      </Card>
    );
  }

  return (
    <Card>
      <h3 className="mb-4 text-sm font-semibold text-text">
        What should we research?
      </h3>
      <p className="mb-5 text-xs text-text-3">
        We gather signal from the last 30 days across Hacker News, GitHub, web,
        Reddit, X, YouTube, and Polymarket, then synthesize a cited brief.
      </p>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          const trimmedTopic = topic.trim();
          const trimmedFocus = focus.trim();
          onSubmit({
            topic: trimmedTopic,
            query: trimmedFocus.length > 0 ? trimmedFocus : trimmedTopic,
            days: 30,
          });
        }}
      >
        <label className="block space-y-1.5 text-xs font-medium text-text">
          Topic
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="e.g. AI coding agents for GTM teams"
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange"
          />
        </label>
        <label className="block space-y-1.5 text-xs font-medium text-text">
          Focus <span className="font-normal text-text-3">(optional)</span>
          <textarea
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            rows={3}
            placeholder="Narrow the query or angle"
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange"
          />
        </label>
        <div className="flex items-center gap-3 pt-1">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!canSubmit}
          >
            Start research
          </Button>
          {!connected ? (
            <p className="text-xs text-text-3">
              Reconnecting — action unavailable.
            </p>
          ) : null}
        </div>
      </form>
    </Card>
  );
}

function ReportScreen({
  stepOutputs,
}: {
  stepOutputs: Record<string, unknown>;
}) {
  const report = parseBriefReport(stepOutputs.brief);
  const reply = parseWriteReply(stepOutputs.write);
  const brief =
    report !== "pending" && report !== "error" && report !== null
      ? report
      : null;

  // The brief lands before the synthesis turn finishes: surface its stats right
  // away so the user sees a concrete result while the report is still writing,
  // rather than a bare spinner (CL-2505).
  if (reply === "pending") {
    return (
      <div className="space-y-4">
        {brief !== null ? <BriefSummary report={brief} /> : null}
        <Card>
          <Spinner label="Synthesizing report…" />
        </Card>
      </div>
    );
  }

  const body = reply;
  const citations = brief !== null ? brief.citations : [];

  return (
    <div className="space-y-4">
      {body.length > 0 ? (
        <Card>
          <h3 className="mb-3 text-sm font-semibold text-text">Synthesis</h3>
          <Markdown>{body}</Markdown>
        </Card>
      ) : null}
      {citations.length > 0 ? (
        <Card>
          <h3 className="mb-3 text-sm font-semibold text-text">
            Citations ({citations.length})
          </h3>
          <ul className="space-y-2 text-sm">
            {citations.map((c) => (
              <li key={c.url}>
                <a
                  href={c.url}
                  className="text-accent hover:underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  {c.title ?? c.url}
                </a>
                <span className="text-text-3"> · {c.source}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function DoneScreen({ stepOutputs }: { stepOutputs: Record<string, unknown> }) {
  const envelope = ToolResultEnvelope(stepOutputs.persist);
  if (envelope instanceof type.errors) {
    return (
      <Card>
        <Spinner label="Saving artifact…" />
      </Card>
    );
  }
  let meta: typeof PersistContent.infer | undefined;
  try {
    const parsed = PersistContent(JSON.parse(envelope.content));
    if (!(parsed instanceof type.errors)) meta = parsed;
  } catch {
    meta = undefined;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-text">Saved to workbench</h3>
        {meta?.title ? (
          <p className="text-sm text-text-2">{meta.title}</p>
        ) : null}
      </div>
      <ReportScreen stepOutputs={stepOutputs} />
    </div>
  );
}

export function Panel(props: WorkflowPanelProps) {
  const { state, connected, signalPending, stepOutputs, onSignal, onClose } =
    props;
  const failed = state?.phase === "failed";
  const current = activeStep(state);
  const liveLabel = failed ? null : currentActivity(state);

  const showShellHeader = workflowPanelShowsShellHeader(props);

  return (
    <div className="flex h-full flex-col bg-surface">
      {showShellHeader ? (
        <header className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
          <div>
            <h2 className="text-base font-medium text-text">
              Last 30 days research
            </h2>
            <p className="text-xs text-text-3">
              Market and community signal with citations
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close panel"
          >
            Close
          </Button>
        </header>
      ) : null}

      <HorizontalStepper steps={buildStepperSteps(state)} />
      <LiveStatusSlot label={liveLabel} />

      <div className="flex-1 overflow-y-auto p-6">
        {failed ? (
          <FailedRunNotice
            state={state}
            steps={DISPLAY_STEPS}
            logRead={props.logRead}
          />
        ) : current === "intake" ? (
          <IntakeScreen
            phase={phaseFor(state, "intake")}
            connected={connected}
            signalPending={signalPending}
            intakeDone={intakeIsDone(state)}
            onSubmit={(payload) => onSignal(INTAKE_SIGNAL, payload)}
          />
        ) : current === "research" ? (
          <SourceProgress state={state} />
        ) : current === "report" ? (
          <ReportScreen stepOutputs={stepOutputs} />
        ) : (
          <DoneScreen stepOutputs={stepOutputs} />
        )}
      </div>
    </div>
  );
}
