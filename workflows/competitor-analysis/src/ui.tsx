/**
 * Competitor Analysis — run-page panel (strangler fallback).
 *
 * Primary operator surface is the dock (see `blocks.ts`). This panel remains
 * the full-page fallback when the operator opens the run directly.
 */
import type { RunState, StepState } from "@intx/workflow";
import {
  activeDisplayStep,
  buildRunStepperSteps,
  Button,
  failedRunErrorMessage,
  HorizontalStepper,
  LiveStatusSlot,
  liveStatusLabel,
  Markdown,
  type WorkflowPanelProps,
  workflowPanelShowsShellHeader,
  type WorkflowStep,
} from "@workbench/ui";
import { useState } from "react";
import { DISPLAY_STEPS } from "./display-steps";
import { parseCompetitorReport } from "./parse";

export { DISPLAY_STEPS };

const INTAKE_SIGNAL = "intake";
const REVIEW_SIGNAL = "review";

type DisplayGroup = "company" | "research" | "report" | "done";

type StepPhase = StepState["phase"];

function phaseFor(state: RunState | null, id: string): StepPhase | undefined {
  return state?.steps.get(id)?.phase;
}

function activeGroup(state: RunState | null): DisplayGroup {
  return (activeDisplayStep(state, DISPLAY_STEPS)?.key ??
    "done") as DisplayGroup;
}

function buildStepperSteps(state: RunState | null): WorkflowStep[] {
  return buildRunStepperSteps(state, DISPLAY_STEPS);
}

// ── Shared primitives ──────────────────────────────────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-[14px] border border-border bg-surface p-4 shadow-sm">
      {children}
    </section>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 text-[13px] font-semibold text-text">{children}</h3>
  );
}

function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-text-3">
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
      <p className="text-[13px] font-medium text-orange">{title}</p>
      {detail !== undefined ? (
        <p className="mt-1 text-[12px] text-text-3">{detail}</p>
      ) : null}
      {onClose !== undefined ? (
        <div className="mt-4">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Start over
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

const fieldClass =
  "w-full rounded-[8px] border border-border bg-bg px-3 py-2 text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange";

// ── Company intake ───────────────────────────────────────────────────────────

function CompanyIntake({
  phase,
  connected,
  signalPending,
  onSubmit,
}: {
  phase: StepPhase | undefined;
  connected: boolean;
  signalPending: boolean;
  onSubmit: (payload: {
    companyUrl: string;
    companyName?: string;
    focusNotes?: string;
  }) => void;
}) {
  const [companyUrl, setCompanyUrl] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [focusNotes, setFocusNotes] = useState("");

  if (phase !== "awaiting-signal") {
    return (
      <Card>
        <CardTitle>Getting ready</CardTitle>
        <Spinner label="Preparing the company form…" />
      </Card>
    );
  }

  const valid = /^https?:\/\/.+/iu.test(companyUrl.trim());
  const canSubmit = connected && !signalPending && valid;

  return (
    <Card>
      <CardTitle>Which company should we analyze?</CardTitle>
      <p className="mb-4 text-[12px] text-text-3">
        We scrape the site, search for alternatives with Exa, and draft a
        competitor shortlist with evidence for you to review.
      </p>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          const payload: {
            companyUrl: string;
            companyName?: string;
            focusNotes?: string;
          } = { companyUrl: companyUrl.trim() };
          const name = companyName.trim();
          const notes = focusNotes.trim();
          if (name.length > 0) payload.companyName = name;
          if (notes.length > 0) payload.focusNotes = notes;
          onSubmit(payload);
        }}
      >
        <label className="block space-y-1.5">
          <span className="text-[12px] font-medium text-text-2">
            Company website URL
          </span>
          <input
            type="url"
            required
            value={companyUrl}
            onChange={(e) => setCompanyUrl(e.target.value)}
            placeholder="https://acme.com"
            className={fieldClass}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[12px] font-medium text-text-2">
            Company name (optional)
          </span>
          <input
            type="text"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="Acme"
            className={fieldClass}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[12px] font-medium text-text-2">
            Focus notes (optional)
          </span>
          <textarea
            value={focusNotes}
            onChange={(e) => setFocusNotes(e.target.value)}
            placeholder="e.g. mid-market CRM, EU region, product-led motion"
            rows={3}
            className={fieldClass}
          />
        </label>
        <div className="flex items-center gap-3 pt-1">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!canSubmit}
          >
            Find competitors
          </Button>
          {!connected ? (
            <p className="text-[12px] text-text-3">
              Reconnecting — input unavailable.
            </p>
          ) : null}
          {connected && signalPending ? <Spinner label="Submitting…" /> : null}
        </div>
      </form>
    </Card>
  );
}

// ── Research progress ─────────────────────────────────────────────────────────

function ResearchScreen({
  state,
  onClose,
}: {
  state: RunState | null;
  onClose: () => void;
}) {
  if (phaseFor(state, "scrape") === "failed") {
    return (
      <ErrorCard
        title="We couldn't scrape that website."
        detail="Double-check the company URL (must be publicly reachable) and try again."
        onClose={onClose}
      />
    );
  }

  return (
    <Card>
      <CardTitle>Researching competitors</CardTitle>
      <Spinner label="Scraping the site, searching alternatives, and ranking peers…" />
      <p className="mt-3 text-[12px] text-text-3">
        This can take a minute while we crawl the company site and run discovery
        searches.
      </p>
    </Card>
  );
}

// ── Report review ─────────────────────────────────────────────────────────────

function ReportReview({
  phase,
  synthesizePhase,
  connected,
  signalPending,
  reportOutput,
  onSubmit,
  onClose,
}: {
  phase: StepPhase | undefined;
  synthesizePhase: StepPhase | undefined;
  connected: boolean;
  signalPending: boolean;
  reportOutput: unknown;
  onSubmit: (approved: boolean) => void;
  onClose: () => void;
}) {
  const result = parseCompetitorReport(reportOutput);

  if (result.status === "pending") {
    if (synthesizePhase === "failed") {
      return (
        <ErrorCard
          title="Couldn't write the report."
          detail="The synthesis step failed. Start a new run."
          onClose={onClose}
        />
      );
    }
    return (
      <Card>
        <CardTitle>Writing the competitor report</CardTitle>
        <Spinner label="Assembling the competitor shortlist…" />
      </Card>
    );
  }

  if (result.status === "malformed") {
    return (
      <ErrorCard
        title="Couldn't read the competitor report."
        detail="The report came back in an unexpected shape. Start a new run."
        onClose={onClose}
      />
    );
  }

  if (phase === "completed") {
    return (
      <Card>
        <CardTitle>Decision recorded</CardTitle>
        <Spinner label="Saving the report to your workbench…" />
      </Card>
    );
  }

  const awaiting = phase === "awaiting-signal";
  const canAct = connected && !signalPending && awaiting;
  const report = result.value;

  return (
    <Card>
      <CardTitle>{report.title}</CardTitle>
      <div className="max-h-[420px] overflow-y-auto rounded-[10px] border border-border bg-bg p-3">
        <Markdown>{report.content}</Markdown>
      </div>
      {report.competitors.length > 0 ? (
        <ul className="mt-3 space-y-2 border-t border-border pt-3">
          {report.competitors.map((c) => (
            <li key={c.name} className="text-[12px] text-text-2">
              <span className="font-medium text-text">{c.name}</span>
              <span className="text-text-3"> · {c.segment}</span>
              <span className="block text-text-3">{c.whyCompetes}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-4 flex items-center gap-3">
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={!canAct}
          onClick={() => {
            if (!canAct) return;
            onSubmit(true);
          }}
        >
          Approve & save
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!canAct}
          onClick={() => {
            if (!canAct) return;
            onSubmit(false);
          }}
        >
          Reject
        </Button>
        {!connected ? (
          <p className="text-[12px] text-text-3">
            Reconnecting — action unavailable.
          </p>
        ) : null}
        {connected && signalPending ? <Spinner label="Submitting…" /> : null}
      </div>
    </Card>
  );
}

// ── Done ────────────────────────────────────────────────────────────────────

function DoneScreen({
  state,
  stepOutputs,
  onClose,
}: {
  state: RunState | null;
  stepOutputs: Record<string, unknown>;
  onClose: () => void;
}) {
  if (
    phaseFor(state, "packageArtifact") !== "completed" &&
    state?.phase !== "completed"
  ) {
    return (
      <Card>
        <CardTitle>Finishing up</CardTitle>
        <Spinner label="Saving the report…" />
      </Card>
    );
  }

  const report = parseCompetitorReport(stepOutputs.synthesize);
  const title =
    report.status === "ok" ? report.value.title : "Competitor analysis";
  const count = report.status === "ok" ? report.value.competitors.length : 0;

  return (
    <Card>
      <CardTitle>Report saved</CardTitle>
      <p className="text-[13px] text-text">{title}</p>
      <p className="mt-1 text-[12px] text-text-3">
        The competitor analysis is in your workbench
        {count > 0
          ? `, with ${String(count)} competitor${count === 1 ? "" : "s"}.`
          : "."}
      </p>
      <div className="mt-4">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </Card>
  );
}

// ── Root Panel ────────────────────────────────────────────────────────────────

export function Panel(props: WorkflowPanelProps) {
  const { state, connected, signalPending, stepOutputs, onSignal, onClose } =
    props;

  const group = activeGroup(state);
  const runPhase = state?.phase;
  const failed = runPhase === "failed" || runPhase === "cancelled";
  const liveLabel = failed ? null : liveStatusLabel(state, DISPLAY_STEPS);
  const failError = failedRunErrorMessage(state) ?? undefined;

  const showShellHeader = workflowPanelShowsShellHeader(props);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      {showShellHeader ? (
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-5 py-3">
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold text-text">
              Competitor Analysis
            </p>
            <p className="mt-px text-[11px] text-text-3">
              {connected ? "Live" : "Reconnecting…"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] border border-border text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
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
        </header>
      ) : null}

      <HorizontalStepper steps={buildStepperSteps(state)} />
      <LiveStatusSlot label={liveLabel} />

      <div className="flex-1 overflow-y-auto p-5">
        {failed ? (
          <ErrorCard
            title="This run failed."
            detail={failError ?? "Review the step details and start over."}
            onClose={onClose}
          />
        ) : group === "company" ? (
          <CompanyIntake
            phase={phaseFor(state, "intake")}
            connected={connected}
            signalPending={signalPending}
            onSubmit={(payload) => onSignal(INTAKE_SIGNAL, payload)}
          />
        ) : group === "research" ? (
          <ResearchScreen state={state} onClose={onClose} />
        ) : group === "report" ? (
          <ReportReview
            phase={phaseFor(state, "review")}
            synthesizePhase={phaseFor(state, "synthesize")}
            connected={connected}
            signalPending={signalPending}
            reportOutput={stepOutputs.synthesize}
            onSubmit={(approved) => onSignal(REVIEW_SIGNAL, { approved })}
            onClose={onClose}
          />
        ) : group === "done" ? (
          <DoneScreen
            state={state}
            stepOutputs={stepOutputs}
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
