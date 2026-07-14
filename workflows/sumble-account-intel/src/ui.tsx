import { useState } from "react";
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
import { DISPLAY_STEPS } from "./display-steps";
import {
  parseAccountBrief,
  parseContactsCsv,
  parseResolvedOrganization,
} from "./parse";

const INTAKE_SIGNAL = "intake";
const REVIEW_SIGNAL = "review";

// The intake gate's output is the posted payload; carry its pushToAttio flag
// forward so the review resume re-affirms the operator's CRM choice.
function intakePushToAttio(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const value = (raw as { pushToAttio?: unknown }).pushToAttio;
  return value === true;
}

type DisplayGroup = "account" | "research" | "brief" | "done";

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

// Renders the brief's `contactsCsv` (header row + one row per contact) as a
// table so the human sees the ranked, X-enriched contacts before approving.
// Returns null when there are no contact rows (only a header, or unparseable).
function ContactsCard({ csv }: { csv: string }) {
  const table = parseContactsCsv(csv);
  if (table === null || table.rows.length === 0) return null;
  const columnLabel = (header: string): string =>
    header.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <div className="mt-3">
      <p className="mb-1 text-[12px] font-medium text-text-2">
        Contacts ({table.rows.length})
      </p>
      <div className="overflow-x-auto rounded-[8px] border border-border">
        <table className="w-full border-collapse text-left text-[12px]">
          <thead>
            <tr className="bg-surface-2 text-text-2">
              {table.headers.map((header, i) => (
                <th key={i} className="px-2.5 py-1.5 font-medium">
                  {columnLabel(header)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, r) => (
              <tr key={r} className="border-t border-border text-text">
                {table.headers.map((_, c) => (
                  <td key={c} className="px-2.5 py-1.5">
                    {row[c] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Account intake ──────────────────────────────────────────────────────────

function AccountIntake({
  phase,
  connected,
  signalPending,
  onSubmit,
}: {
  phase: StepPhase | undefined;
  connected: boolean;
  signalPending: boolean;
  onSubmit: (payload: {
    organizationDomain: string;
    pushToAttio: boolean;
  }) => void;
}) {
  const [organizationDomain, setOrganizationDomain] = useState("");
  const [pushToAttio, setPushToAttio] = useState(false);

  if (phase !== "awaiting-signal") {
    return (
      <Card>
        <CardTitle>Getting ready</CardTitle>
        <Spinner label="Preparing the account form…" />
      </Card>
    );
  }

  const valid = organizationDomain.trim().length > 0;
  const canSubmit = connected && !signalPending && valid;

  return (
    <Card>
      <CardTitle>Which account should we research?</CardTitle>
      <p className="mb-4 text-[12px] text-text-3">
        Enter the company domain (like acme.com) or its Sumble company ID. We
        pull the org shape, tech stack, contacts, and buying signals, then write
        a reviewable brief.
      </p>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          onSubmit({
            organizationDomain: organizationDomain.trim(),
            pushToAttio,
          });
        }}
      >
        <label className="block space-y-1.5">
          <span className="text-[12px] font-medium text-text-2">
            Company domain or Sumble company ID
          </span>
          <input
            type="text"
            value={organizationDomain}
            onChange={(e) => setOrganizationDomain(e.target.value)}
            placeholder="acme.com"
            className={fieldClass}
          />
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded-[8px] border border-border bg-bg px-3 py-2.5">
          <input
            type="checkbox"
            checked={pushToAttio}
            onChange={(e) => setPushToAttio(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-orange"
          />
          <span>
            <span className="block text-[13px] font-medium text-text">
              Push a note to Attio
            </span>
            <span className="block text-[12px] text-text-3">
              Flag this account for a CRM follow-up after the brief is approved.
            </span>
          </span>
        </label>
        <div className="flex items-center gap-3 pt-1">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!canSubmit}
          >
            Research account
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
  stepOutputs,
  onClose,
}: {
  state: RunState | null;
  stepOutputs: Record<string, unknown>;
  onClose: () => void;
}) {
  if (phaseFor(state, "resolve") === "failed") {
    return (
      <ErrorCard
        title="We couldn't find that company."
        detail="Double-check the company domain (like acme.com) or the company ID and try again."
        onClose={onClose}
      />
    );
  }

  const resolved = parseResolvedOrganization(stepOutputs.resolve);
  const orgName =
    resolved.status === "ok" && resolved.value !== null
      ? (resolved.value.name ?? undefined)
      : undefined;

  return (
    <Card>
      <CardTitle>Researching the account</CardTitle>
      {orgName !== undefined ? (
        <p className="mb-3 text-[12px] text-text-3">
          Account: <span className="font-medium text-text-2">{orgName}</span>
        </p>
      ) : null}
      <Spinner label="Pulling teams, jobs, tech stack, contacts, and signals…" />
    </Card>
  );
}

// ── Brief review ──────────────────────────────────────────────────────────────

function BriefReview({
  phase,
  synthesizePhase,
  connected,
  signalPending,
  briefOutput,
  onSubmit,
  onClose,
}: {
  phase: StepPhase | undefined;
  synthesizePhase: StepPhase | undefined;
  connected: boolean;
  signalPending: boolean;
  briefOutput: unknown;
  onSubmit: (approved: boolean) => void;
  onClose: () => void;
}) {
  const result = parseAccountBrief(briefOutput);

  if (result.status === "pending") {
    if (synthesizePhase === "failed") {
      return (
        <ErrorCard
          title="Couldn't write the brief."
          detail="The synthesis step failed. Start a new run."
          onClose={onClose}
        />
      );
    }
    return (
      <Card>
        <CardTitle>Writing the account brief</CardTitle>
        <Spinner label="Synthesizing the research into a brief…" />
      </Card>
    );
  }

  if (result.status === "malformed") {
    return (
      <ErrorCard
        title="Couldn't read the account brief."
        detail="The brief came back in an unexpected shape. Start a new run."
        onClose={onClose}
      />
    );
  }

  if (phase === "completed") {
    return (
      <Card>
        <CardTitle>Approved</CardTitle>
        <Spinner label="Saving the brief to your workbench…" />
      </Card>
    );
  }

  const awaiting = phase === "awaiting-signal";
  const canAct = connected && !signalPending && awaiting;
  const brief = result.value;

  return (
    <Card>
      <CardTitle>{brief.title}</CardTitle>
      <div className="max-h-[420px] overflow-y-auto rounded-[10px] border border-border bg-bg p-3">
        <Markdown>{brief.content}</Markdown>
      </div>
      <ContactsCard csv={brief.contactsCsv} />
      {brief.slackDraft.trim().length > 0 ? (
        <div className="mt-3">
          <p className="mb-1 text-[12px] font-medium text-text-2">
            Slack draft
          </p>
          <p className="whitespace-pre-wrap rounded-[8px] border border-border bg-surface-2 p-3 text-[12px] text-text-2">
            {brief.slackDraft}
          </p>
        </div>
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
        <Spinner label="Saving the brief…" />
      </Card>
    );
  }

  const brief = parseAccountBrief(stepOutputs.synthesize);
  const title = brief.status === "ok" ? brief.value.title : "Account brief";
  const contactCount =
    brief.status === "ok"
      ? (parseContactsCsv(brief.value.contactsCsv)?.rows.length ?? 0)
      : 0;

  return (
    <Card>
      <CardTitle>Brief saved</CardTitle>
      <p className="text-[13px] text-text">{title}</p>
      <p className="mt-1 text-[12px] text-text-3">
        The account intelligence brief is in your workbench
        {contactCount > 0
          ? `, with ${String(contactCount)} contact${contactCount === 1 ? "" : "s"}.`
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
              Sumble Account Intelligence
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
        ) : group === "account" ? (
          <AccountIntake
            phase={phaseFor(state, "intake")}
            connected={connected}
            signalPending={signalPending}
            onSubmit={(payload) => onSignal(INTAKE_SIGNAL, payload)}
          />
        ) : group === "research" ? (
          <ResearchScreen
            state={state}
            stepOutputs={stepOutputs}
            onClose={onClose}
          />
        ) : group === "brief" ? (
          <BriefReview
            phase={phaseFor(state, "review")}
            synthesizePhase={phaseFor(state, "synthesize")}
            connected={connected}
            signalPending={signalPending}
            briefOutput={stepOutputs.synthesize}
            onSubmit={(approved) =>
              onSignal(REVIEW_SIGNAL, {
                approved,
                pushToAttio: intakePushToAttio(stepOutputs.intake),
              })
            }
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
