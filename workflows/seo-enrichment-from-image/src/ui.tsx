import { useState } from "react";
import type { ReactNode } from "react";
import { type } from "arktype";
import type { RunState, StepState } from "@intx/workflow";
import {
  Button,
  HorizontalStepper,
  type WorkflowPanelProps,
  type WorkflowStep,
} from "@workbench/ui";

const STEP_ORDER = ["intake", "enrich", "review", "persist"] as const;
type StepKey = (typeof STEP_ORDER)[number];

const STEP_LABELS: Record<StepKey, string> = {
  intake: "Intake",
  enrich: "Enrich",
  review: "Review",
  persist: "Persist",
};

type StepPhase = StepState["phase"];

// Enrich agent emits STRICT JSON in its reply field.
const AgentStepOutput = type({ reply: "string", "turn?": "unknown" });

const EnrichRow = type({
  id: "string",
  field: "string",
  value: "string",
  "note?": "string",
});

const EnrichOutput = type({ rows: EnrichRow.array() });
type EnrichOutputT = typeof EnrichOutput.infer;
type EnrichRowT = typeof EnrichRow.infer;

// deterministicToolStep output: { callId, content: "<JSON>" }
const ToolResultEnvelope = type({ content: "string", "callId?": "string" });

const PersistContent = type({
  "artifactId?": "string",
  "title?": "string",
  "kind?": "string",
  "version?": "number",
});

function stepPhase(
  state: RunState | null,
  stepId: StepKey,
): StepPhase | undefined {
  return state?.steps.get(stepId)?.phase;
}

function toStepperStatus(phase: StepPhase | undefined): WorkflowStep["status"] {
  if (phase === "completed") return "completed";
  if (
    phase === "in-flight" ||
    phase === "awaiting-signal" ||
    phase === "awaiting-timer"
  ) {
    return "current";
  }
  return "pending";
}

function buildStepperSteps(state: RunState | null): WorkflowStep[] {
  return STEP_ORDER.map((stepId, index) => ({
    number: index + 1,
    label: STEP_LABELS[stepId],
    status: toStepperStatus(stepPhase(state, stepId)),
  }));
}

function deriveActiveStep(state: RunState | null): StepKey {
  for (const key of STEP_ORDER) {
    const phase = stepPhase(state, key);
    if (
      phase === "awaiting-signal" ||
      phase === "in-flight" ||
      phase === "awaiting-timer"
    ) {
      return key;
    }
  }
  // Fall back to the furthest completed step, or persist once everything is done.
  for (let i = STEP_ORDER.length - 1; i >= 0; i--) {
    const key = STEP_ORDER[i];
    if (key !== undefined && stepPhase(state, key) === "completed") return key;
  }
  return "intake";
}

function parseEnrichOutput(raw: unknown): EnrichOutputT | null {
  const envelope = AgentStepOutput(raw);
  if (envelope instanceof type.errors) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(envelope.reply);
  } catch {
    return null;
  }
  const parsed = EnrichOutput(decoded);
  if (parsed instanceof type.errors) return null;
  return parsed;
}

function readPersistedArtifact(
  output: unknown,
): { artifactId?: string; title?: string; kind?: string } | null {
  const envelope = ToolResultEnvelope(output);
  if (envelope instanceof type.errors) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(envelope.content);
  } catch {
    return null;
  }
  const parsed = PersistContent(decoded);
  if (parsed instanceof type.errors) return null;
  return {
    ...(parsed.artifactId !== undefined
      ? { artifactId: parsed.artifactId }
      : {}),
    ...(parsed.title !== undefined ? { title: parsed.title } : {}),
    ...(parsed.kind !== undefined ? { kind: parsed.kind } : {}),
  };
}

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-panel border border-border bg-surface p-5">
      <h3 className="mb-3 text-sm font-medium text-text">{title}</h3>
      {children}
    </section>
  );
}

function IntakeSection({
  phase,
  connected,
  signalPending,
  onSubmit,
}: {
  phase: StepPhase | undefined;
  connected: boolean;
  signalPending: boolean;
  onSubmit: (payload: { imageUrl: string; pageUrl: string }) => void;
}) {
  const [imageUrl, setImageUrl] = useState("");
  const [pageUrl, setPageUrl] = useState("");
  const canSubmit =
    connected &&
    !signalPending &&
    imageUrl.trim().length > 0 &&
    pageUrl.trim().length > 0;

  if (phase === "completed") {
    return (
      <SectionCard title="Intake — product URLs">
        <p className="text-sm text-text-2">URLs submitted.</p>
      </SectionCard>
    );
  }

  if (phase !== "awaiting-signal") {
    return (
      <SectionCard title="Intake — product URLs">
        <p className="text-sm text-text-3">Waiting for the run to start.</p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Intake — product URLs">
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          onSubmit({ imageUrl: imageUrl.trim(), pageUrl: pageUrl.trim() });
        }}
      >
        <label className="block space-y-1">
          <span className="text-sm font-medium text-text">
            Product image URL
          </span>
          <input
            type="url"
            className="w-full rounded-lg border border-border bg-surface-2 p-2 text-sm text-text"
            value={imageUrl}
            onChange={(event) => setImageUrl(event.target.value)}
            placeholder="https://example.com/product.jpg"
            aria-label="Product image URL"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium text-text">Target page URL</span>
          <input
            type="url"
            className="w-full rounded-lg border border-border bg-surface-2 p-2 text-sm text-text"
            value={pageUrl}
            onChange={(event) => setPageUrl(event.target.value)}
            placeholder="https://example.com/product-page"
            aria-label="Target page URL"
          />
        </label>
        <Button type="submit" variant="primary" size="sm" disabled={!canSubmit}>
          Start enrichment
        </Button>
        {!connected && (
          <p className="text-xs text-text-3">
            Reconnecting — input is unavailable.
          </p>
        )}
      </form>
    </SectionCard>
  );
}

function EnrichSection({
  phase,
  output,
}: {
  phase: StepPhase | undefined;
  output: unknown;
}) {
  const parsed = parseEnrichOutput(output);
  if (parsed === null) {
    return (
      <SectionCard title="Enrich — SEO metadata">
        {phase === "completed" ? (
          <p className="text-sm text-orange">
            Couldn't read the enrichment output.
          </p>
        ) : (
          <p className="text-sm text-text-3">
            {phase === "in-flight"
              ? "Extracting SEO metadata…"
              : "Waiting for enrichment."}
          </p>
        )}
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Enrich — SEO metadata">
      <ul className="space-y-2">
        {parsed.rows.map((row: EnrichRowT) => (
          <li
            key={row.id}
            className="rounded-lg border border-border bg-surface-2 p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="text-xs font-medium text-text-2">
                {row.field}
              </span>
            </div>
            <p className="mt-1 text-sm text-text">{row.value}</p>
            {row.note !== undefined && (
              <p className="mt-1 text-xs text-text-3">{row.note}</p>
            )}
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function ReviewSection({
  phase,
  enrichOutput,
  connected,
  signalPending,
  onSubmit,
}: {
  phase: StepPhase | undefined;
  enrichOutput: unknown;
  connected: boolean;
  signalPending: boolean;
  onSubmit: (payload: { selectedIds: string[] }) => void;
}) {
  const parsed = parseEnrichOutput(enrichOutput);
  const rows = parsed?.rows ?? [];
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(rows.map((r: EnrichRowT) => r.id)),
  );
  const [submitted, setSubmitted] = useState(false);

  function toggleId(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  if (phase === "completed") {
    return (
      <SectionCard title="Review — select rows">
        <p className="text-sm text-text-2">Selection confirmed.</p>
      </SectionCard>
    );
  }

  if (phase !== "awaiting-signal") {
    return (
      <SectionCard title="Review — select rows">
        <p className="text-sm text-text-3">Waiting for enrichment to finish.</p>
      </SectionCard>
    );
  }

  if (parsed === null) {
    return (
      <SectionCard title="Review — select rows">
        <p className="text-sm text-orange">
          Couldn't read the enrichment output.
        </p>
      </SectionCard>
    );
  }

  if (rows.length === 0) {
    return (
      <SectionCard title="Review — select rows">
        <p className="text-sm text-text-3">No metadata rows to review.</p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Review — select rows">
      <p className="mb-3 text-sm text-text-2">
        Select the metadata rows to save as an artifact.
      </p>
      <ul className="mb-4 space-y-2">
        {rows.map((row: EnrichRowT) => (
          <li key={row.id}>
            <label className="flex items-start gap-3 rounded-lg border border-border bg-surface-2 p-3 cursor-pointer">
              <input
                type="checkbox"
                checked={selectedIds.has(row.id)}
                onChange={() => toggleId(row.id)}
                disabled={submitted}
                aria-label={`Select ${row.field}`}
                className="mt-0.5 flex-shrink-0"
              />
              <div className="min-w-0">
                <p className="text-xs font-medium text-text-2">{row.field}</p>
                <p className="text-sm text-text">{row.value}</p>
                {row.note !== undefined && (
                  <p className="text-xs text-text-3">{row.note}</p>
                )}
              </div>
            </label>
          </li>
        ))}
      </ul>
      <Button
        variant="primary"
        size="sm"
        disabled={
          selectedIds.size === 0 || submitted || signalPending || !connected
        }
        onClick={() => {
          if (selectedIds.size === 0 || submitted) return;
          onSubmit({ selectedIds: [...selectedIds] });
          setSubmitted(true);
        }}
      >
        {submitted ? "Selection submitted" : "Save selected rows"}
      </Button>
      {!connected && (
        <p className="mt-2 text-xs text-text-3">
          Reconnecting — saving is unavailable.
        </p>
      )}
    </SectionCard>
  );
}

function PersistSection({
  phase,
  output,
}: {
  phase: StepPhase | undefined;
  output: unknown;
}) {
  const artifact = readPersistedArtifact(output);

  if (artifact === null) {
    return (
      <SectionCard title="Persist — saved artifact">
        {phase === "completed" ? (
          <p className="text-sm text-orange">
            Couldn't read the saved artifact.
          </p>
        ) : (
          <p className="text-sm text-text-3">
            {phase === "in-flight" ? "Saving artifact…" : "Waiting to save."}
          </p>
        )}
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Persist — saved artifact">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 p-3">
        <span className="min-w-0 truncate text-sm text-text">
          {artifact.title ?? artifact.artifactId ?? "Saved artifact"}
        </span>
        {artifact.kind !== undefined && (
          <span className="text-xs text-text-3">{artifact.kind}</span>
        )}
      </div>
    </SectionCard>
  );
}

export function Panel(props: WorkflowPanelProps) {
  const { state, connected, signalPending, stepOutputs, onSignal, onClose } =
    props;
  const failed = state?.phase === "failed";
  const activeStep = deriveActiveStep(state);

  function handleIntakeSubmit(payload: { imageUrl: string; pageUrl: string }) {
    onSignal("intake", payload);
  }

  function handleReviewSubmit(payload: { selectedIds: string[] }) {
    onSignal("row-selection", payload);
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div>
          <h2 className="text-base font-medium text-text">
            SEO Enrichment from Image
          </h2>
          <p className="text-xs text-text-3">
            {connected ? "Connected" : "Reconnecting…"}
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

      {failed && (
        <div className="mx-6 mt-4 rounded-panel border border-orange bg-orange-soft p-4">
          <p className="text-sm text-orange-deep">
            This run failed. Review the run log and try again.
          </p>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-6">
        {activeStep === "intake" && (
          <IntakeSection
            phase={stepPhase(state, "intake")}
            connected={connected}
            signalPending={signalPending}
            onSubmit={handleIntakeSubmit}
          />
        )}
        {activeStep === "enrich" && (
          <EnrichSection
            phase={stepPhase(state, "enrich")}
            output={stepOutputs.enrich}
          />
        )}
        {activeStep === "review" && (
          <ReviewSection
            phase={stepPhase(state, "review")}
            enrichOutput={stepOutputs.enrich}
            connected={connected}
            signalPending={signalPending}
            onSubmit={handleReviewSubmit}
          />
        )}
        {activeStep === "persist" && (
          <PersistSection
            phase={stepPhase(state, "persist")}
            output={stepOutputs.persist}
          />
        )}
      </div>
    </div>
  );
}
