import { useState } from "react";
import { type } from "arktype";
import type { RunState, StepState } from "@intx/workflow";
import {
  Button,
  HorizontalStepper,
  Markdown,
  type WorkflowPanelProps,
  type WorkflowStep,
} from "@workbench/ui";
import { parseReport } from "@workbench/last30days-core";

const INTAKE_SIGNAL = "intake";

const STEP_ORDER = ["intake", "research", "report", "done"] as const;
type StepKey = (typeof STEP_ORDER)[number];

const STEP_LABELS: Record<StepKey, string> = {
  intake: "Topic",
  research: "Research",
  report: "Report",
  done: "Done",
};

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
  const ids = [
    "hackernews",
    "github",
    "web",
    "reddit",
    "x",
    "youtube",
    "rerank",
    "brief",
  ] as const;
  if (phaseFor(state, "brief") === "completed") return "completed";
  for (const id of ids) {
    const p = phaseFor(state, id);
    if (p === "in-flight" || p === "awaiting-signal" || p === "awaiting-timer")
      return p;
    if (p === "failed") return "failed";
  }
  if (phaseFor(state, "intake") === "completed") return "in-flight";
  return undefined;
}

function toStepperStatus(
  step: StepKey,
  state: RunState | null,
): WorkflowStep["status"] {
  if (step === "intake") {
    const p = phaseFor(state, "intake");
    if (p === "completed") return "completed";
    if (p === "awaiting-signal" || p === "in-flight") return "current";
    return "pending";
  }
  if (step === "research") {
    const p = researchPhase(state);
    if (p === "completed") return "completed";
    if (
      p === "in-flight" ||
      p === "awaiting-signal" ||
      p === "awaiting-timer" ||
      p === "failed"
    ) {
      return "current";
    }
    return phaseFor(state, "intake") === "completed" ? "current" : "pending";
  }
  if (step === "report") {
    const write = phaseFor(state, "write");
    const persist = phaseFor(state, "persist");
    if (persist === "completed") return "completed";
    if (write === "completed" || write === "in-flight") return "current";
    return "pending";
  }
  const persist = phaseFor(state, "persist");
  if (persist === "completed") return "completed";
  if (persist === "in-flight") return "current";
  return phaseFor(state, "write") === "completed" ? "current" : "pending";
}

function buildStepperSteps(state: RunState | null): WorkflowStep[] {
  return STEP_ORDER.map((stepId, index) => ({
    number: index + 1,
    label: STEP_LABELS[stepId],
    status: toStepperStatus(stepId, state),
  }));
}

function activeStep(state: RunState | null): StepKey {
  if (phaseFor(state, "intake") !== "completed") return "intake";
  if (researchPhase(state) !== "completed") return "research";
  if (phaseFor(state, "write") !== "completed") return "report";
  return "done";
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
  return (
    <section className="rounded-panel border border-border bg-surface p-6">
      {children}
    </section>
  );
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
  { id: "hackernews", label: "Hacker News" },
  { id: "github", label: "GitHub" },
  { id: "web", label: "Web" },
  { id: "reddit", label: "Reddit" },
  { id: "x", label: "X" },
  { id: "youtube", label: "YouTube" },
  { id: "rerank", label: "Ranking relevance" },
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
  if (phase === "completed") return { text: "done", tone: "text-success" };
  if (phase === "failed") return { text: "skipped", tone: "text-text-3" };
  // Summit Blue for in-progress (cool, informational); orange is reserved for
  // the single primary action on screen ("Start research").
  if (isRunningPhase(phase)) return { text: "running", tone: "text-blue" };
  return { text: "waiting", tone: "text-text-3" };
}

function SourceProgress({ state }: { state: RunState | null }) {
  return (
    <Card>
      <h3 className="mb-4 text-sm font-semibold text-text">
        Gathering sources
      </h3>
      <ul className="space-y-2.5">
        {SOURCE_PROGRESS.map(({ id, label }) => {
          const phase = phaseFor(state, id);
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
  onSubmit,
}: {
  phase: StepPhase | undefined;
  connected: boolean;
  signalPending: boolean;
  onSubmit: (payload: IntakePayload) => void;
}) {
  const [topic, setTopic] = useState("");
  const [focus, setFocus] = useState("");

  const canSubmit = connected && !signalPending && topic.trim().length > 0;

  if (phase !== "awaiting-signal") {
    return (
      <Card>
        <Spinner label="Setting up workflow…" />
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
        Reddit, X, and YouTube, then synthesize a cited brief.
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

  if (reply === "pending" && report === "pending") {
    return (
      <Card>
        <Spinner label="Writing report…" />
      </Card>
    );
  }

  const body = reply !== "pending" ? reply : "";
  const citations =
    report !== "pending" && report !== "error" && report !== null
      ? report.citations
      : [];

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
                  className="text-orange underline"
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

  return (
    <div className="flex h-full flex-col bg-surface">
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

      <HorizontalStepper steps={buildStepperSteps(state)} />

      <div className="flex-1 overflow-y-auto p-6">
        {failed ? (
          <Card>
            <p className="text-sm font-medium text-text">Run failed</p>
            <p className="mt-1 text-sm text-text-3">
              Start a new run to try again.
            </p>
          </Card>
        ) : current === "intake" ? (
          <IntakeScreen
            phase={phaseFor(state, "intake")}
            connected={connected}
            signalPending={signalPending}
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
