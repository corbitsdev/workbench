import type {
  ScheduleFieldMetadata,
  WorkflowCatalogEntry,
} from "@workbench/shared";
import { ScheduleFieldForm } from "./ScheduleFieldForm";

export type RunOnceFlowProps = {
  entry: WorkflowCatalogEntry;
  productLabel: string;
  fieldValues: Record<string, unknown>;
  onFieldValuesChange: (next: Record<string, unknown>) => void;
  fields: readonly ScheduleFieldMetadata[];
  error: string | null;
  busy?: boolean;
  onCancel: () => void;
  onSave: () => void | Promise<void>;
};

/**
 * Single-run create panel (CL-4335): the "Run once" side of the create-flow
 * mode selector. A one-time immediate run has no recurrence or scope to
 * configure — it starts a run of the kind's deployment directly
 * (`useStartWorkflow`, the same immediate-start path the catalog's "Start"
 * control and a schedule's "Run now" control already use) rather than
 * persisting a schedule. Mirrors `ScheduleFlow`'s intake-field section only.
 */
export function RunOnceFlow({
  entry,
  productLabel,
  fieldValues,
  onFieldValuesChange,
  fields,
  error,
  busy = false,
  onCancel,
  onSave,
}: RunOnceFlowProps) {
  const hasInputFields = fields.length > 0;

  const handleSave = () => {
    void onSave();
  };

  return (
    <div
      className="mt-4 border-t border-border pt-4"
      data-testid={`run-once-editor-${entry.kind}`}
    >
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-text">{productLabel}</h3>
        {entry.description ? (
          <p className="mt-1 text-sm text-text-2">{entry.description}</p>
        ) : null}
        <p className="mt-1 text-xs text-text-3">
          Runs once, right now, with the inputs below. It won&rsquo;t repeat or
          be saved as a schedule.
        </p>
      </div>

      {hasInputFields ? (
        <div className="mb-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.05em] text-text-3">
            Inputs for this run
          </p>
          <ScheduleFieldForm
            fields={fields}
            values={fieldValues}
            onChange={onFieldValuesChange}
            idPrefix={`run-once-${entry.kind}`}
          />
        </div>
      ) : (
        <p className="mb-4 text-xs text-text-3">
          No inputs needed — this workflow runs with defaults.
        </p>
      )}

      {error ? (
        <p className="mt-2 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-[10px] bg-orange px-3.5 py-2 text-sm font-semibold text-white"
          onClick={handleSave}
          disabled={busy}
          data-testid="run-once-primary"
        >
          Run once now
        </button>
        <button
          type="button"
          className="rounded-[10px] border border-border px-3.5 py-2 text-sm text-text-2"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
