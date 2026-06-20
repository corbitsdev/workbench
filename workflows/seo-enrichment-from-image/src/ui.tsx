import { useMemo, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { type } from 'arktype';
import type { RunState, StepPhase } from '@intx/workflow';
import type { WorkflowPanelProps } from '@workbench/ui';

const STEP_ORDER = ['intake', 'enrich', 'review', 'export'] as const;
type StepKey = (typeof STEP_ORDER)[number];

const STEP_LABELS: Record<StepKey, string> = {
  intake: 'Intake',
  enrich: 'Enrich',
  review: 'Review',
  export: 'Export',
};

const IntakeOutput = type({
  rows: type({
    id: 'string',
    name: 'string',
    'imageUrl?': 'string',
    'targetUrl?': 'string',
  }).array(),
});

const FieldVariants = type({
  titles: 'string[]',
  descriptions: 'string[]',
  summaries: 'string[]',
});

const EnrichOutput = type({
  rows: type({
    id: 'string',
    name: 'string',
    variants: FieldVariants,
  }).array(),
});

const ExportOutput = type({
  filename: 'string',
  csv: 'string',
  'downloadUrl?': 'string',
});

type IntakeRow = (typeof IntakeOutput.infer)['rows'][number];
type EnrichRow = (typeof EnrichOutput.infer)['rows'][number];
type FieldKey = 'titles' | 'descriptions' | 'summaries';

const FIELD_KEYS: { key: FieldKey; label: string }[] = [
  { key: 'titles', label: 'Title' },
  { key: 'descriptions', label: 'Description' },
  { key: 'summaries', label: 'Summary' },
];

type StepView = { key: StepKey; label: string; phase: StepPhase | 'pending'; number: number };

function buildStepViews(state: RunState | null): StepView[] {
  return STEP_ORDER.map((key, idx) => {
    const phase = state?.steps.get(key)?.phase ?? 'pending';
    return { key, label: STEP_LABELS[key], phase, number: idx + 1 };
  });
}

function indicatorClass(phase: StepPhase | 'pending'): string {
  if (phase === 'completed') return 'bg-green text-white';
  if (phase === 'failed' || phase === 'cancelled') return 'bg-surface-2 text-orange';
  if (phase === 'pending') return 'bg-surface-2 text-text-3';
  return 'bg-orange text-white';
}

function Stepper({ steps }: { steps: StepView[] }) {
  return (
    <div className="flex items-center gap-2 border-b border-border bg-surface px-6 py-4">
      {steps.map((s, idx) => (
        <div key={s.key} className="flex items-center gap-2">
          <div
            className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-medium ${indicatorClass(s.phase)}`}
          >
            {s.phase === 'completed' ? '✓' : s.number}
          </div>
          <span
            className={`whitespace-nowrap text-sm ${s.phase === 'pending' ? 'text-text-3' : 'text-text'}`}
          >
            {s.label}
          </span>
          {idx < steps.length - 1 && <div className="mx-1 h-px w-4 bg-border-strong" />}
        </div>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-panel border border-border bg-surface p-4">
      <h3 className="mb-3 text-sm font-semibold text-text">{title}</h3>
      {children}
    </section>
  );
}

function IntakeView({ output }: { output: unknown }) {
  const parsed = IntakeOutput(output);
  if (parsed instanceof type.errors) {
    return <p className="text-sm text-text-3">No intake data yet.</p>;
  }
  if (parsed.rows.length === 0) {
    return <p className="text-sm text-text-3">No product rows were parsed.</p>;
  }
  return (
    <ul className="space-y-2">
      {parsed.rows.map((row: IntakeRow) => (
        <li key={row.id} className="rounded-panel border border-border bg-surface-2 p-3">
          <p className="text-sm font-medium text-text">{row.name}</p>
          {row.targetUrl && <p className="text-xs text-text-3">{row.targetUrl}</p>}
        </li>
      ))}
    </ul>
  );
}

function EnrichView({ output }: { output: unknown }) {
  const parsed = EnrichOutput(output);
  if (parsed instanceof type.errors) {
    return <p className="text-sm text-text-3">No enrichment data yet.</p>;
  }
  return (
    <div className="space-y-4">
      {parsed.rows.map((row: EnrichRow) => (
        <div key={row.id} className="rounded-panel border border-border bg-surface-2 p-3">
          <p className="mb-2 text-sm font-medium text-text">{row.name}</p>
          {FIELD_KEYS.map(({ key, label }) => (
            <div key={key} className="mb-2">
              <p className="text-xs font-medium text-text-2">{label}</p>
              <ul className="ml-3 list-disc text-xs text-text-3">
                {row.variants[key].map((v, i) => (
                  <li key={i}>{v}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

type Selection = { titles?: string; descriptions?: string; summaries?: string };
type SelectionState = Record<string, Selection>;

function ReviewView({
  output,
  onSignal,
}: {
  output: unknown;
  onSignal: WorkflowPanelProps['onSignal'];
}) {
  const parsed = EnrichOutput(output);
  const rows: EnrichRow[] = parsed instanceof type.errors ? [] : parsed.rows;
  const [selections, setSelections] = useState<SelectionState>({});
  const [submitted, setSubmitted] = useState(false);

  function choose(rowId: string, field: FieldKey, value: string) {
    setSelections((prev) => ({ ...prev, [rowId]: { ...prev[rowId], [field]: value } }));
  }

  const allChosen = useMemo(
    () =>
      rows.length > 0 &&
      rows.every((row) => {
        const sel = selections[row.id];
        return Boolean(sel?.titles && sel?.descriptions && sel?.summaries);
      }),
    [rows, selections],
  );

  function confirm() {
    const chosen = rows.map((row) => {
      const sel = selections[row.id] ?? {};
      return {
        id: row.id,
        name: row.name,
        title: sel.titles ?? '',
        description: sel.descriptions ?? '',
        summary: sel.summaries ?? '',
      };
    });
    onSignal('row-selection', { selections: chosen });
    setSubmitted(true);
  }

  if (rows.length === 0) {
    return <p className="text-sm text-text-3">Waiting for enrichment results to review.</p>;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-2">Pick one option per field for each product row.</p>
      {rows.map((row) => (
        <div key={row.id} className="rounded-panel border border-border bg-surface-2 p-3">
          <p className="mb-2 text-sm font-medium text-text">{row.name}</p>
          {FIELD_KEYS.map(({ key, label }) => {
            const fieldName = `${row.id}-${key}`;
            return (
              <fieldset key={key} className="mb-3">
                <legend className="mb-1 text-xs font-medium text-text-2">{label}</legend>
                <div className="space-y-1">
                  {row.variants[key].map((v, i) => (
                    <label key={i} className="flex items-start gap-2 text-xs text-text">
                      <input
                        type="radio"
                        name={fieldName}
                        value={v}
                        checked={selections[row.id]?.[key] === v}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          choose(row.id, key, e.target.value)
                        }
                        aria-label={`${row.name} ${label} option ${i + 1}`}
                      />
                      <span>{v}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          })}
        </div>
      ))}
      <button
        type="button"
        disabled={!allChosen || submitted}
        onClick={confirm}
        className="rounded-panel bg-orange px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {submitted ? 'Selection submitted' : 'Confirm selections'}
      </button>
    </div>
  );
}

function ExportView({ output }: { output: unknown }) {
  const parsed = ExportOutput(output);
  if (parsed instanceof type.errors) {
    return <p className="text-sm text-text-3">The CSV is not ready yet.</p>;
  }
  return (
    <div className="space-y-3">
      {parsed.downloadUrl ? (
        <a
          href={parsed.downloadUrl}
          download={parsed.filename}
          className="inline-block rounded-panel bg-orange px-4 py-2 text-sm font-medium text-white"
        >
          Download {parsed.filename}
        </a>
      ) : (
        <p className="text-sm font-medium text-text">{parsed.filename}</p>
      )}
      <pre className="max-h-64 overflow-auto rounded-panel border border-border bg-surface-2 p-3 text-xs text-text-2">
        {parsed.csv}
      </pre>
    </div>
  );
}

export function Panel(props: WorkflowPanelProps) {
  const { state, connected, stepOutputs, onSignal, onClose } = props;
  const steps = buildStepViews(state);
  const failed =
    state?.phase === 'failed' ||
    steps.some((s) => s.phase === 'failed' || s.phase === 'cancelled');
  const failedStep = steps.find((s) => s.phase === 'failed' || s.phase === 'cancelled');
  const failError = failedStep ? state?.steps.get(failedStep.key)?.lastError?.message : undefined;

  return (
    <div className="flex h-full flex-col rounded-panel border border-border bg-surface text-text">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h2 className="text-base font-semibold text-text">SEO Enrichment from Image</h2>
          <p className="text-xs text-text-3">
            {connected ? 'Connected' : 'Reconnecting…'}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          className="rounded-panel px-2 py-1 text-text-3 hover:bg-surface-2 hover:text-text"
        >
          {'✕'}
        </button>
      </header>

      <Stepper steps={steps} />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        {failed && (
          <div className="rounded-panel border border-orange bg-surface-2 p-4">
            <p className="text-sm font-medium text-orange">This workflow run failed.</p>
            {failError && <p className="mt-1 text-xs text-text-2">{failError}</p>}
          </div>
        )}

        <Section title="Intake">
          <IntakeView output={stepOutputs.intake} />
        </Section>

        <Section title="Enrichment variants">
          <EnrichView output={stepOutputs.enrich} />
        </Section>

        {state?.steps.get('review')?.phase === 'awaiting-signal' && (
          <Section title="Review &amp; select">
            <ReviewView output={stepOutputs.enrich} onSignal={onSignal} />
          </Section>
        )}

        <Section title="Export">
          <ExportView output={stepOutputs.export} />
        </Section>
      </div>
    </div>
  );
}
