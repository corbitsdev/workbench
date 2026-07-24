import { useEffect, useMemo, useState } from "react";
import type {
  ScheduleFieldMetadata,
  ScheduleRecurrence,
  ScheduleScope,
  ScheduledTrigger,
  WorkflowCatalogEntry,
} from "@workbench/shared";
import {
  buildScheduleTriggerPayload,
  HEARTBEAT_WORKFLOW_KIND,
} from "@workbench/shared";
import {
  CreateScheduleFormLayout,
  CreateScheduleSummary,
  KindPickerShell,
  type KindPickerItem,
} from "@workbench/workflows-ui/react";
import { scheduleFieldsComplete } from "../../components/ScheduleFieldForm";
import { ScheduleFlow } from "../../components/ScheduleFlow";
import { RunOnceFlow } from "../../components/RunOnceFlow";
import { useCreateSchedule } from "../../hooks/use-schedules";
import { useStartWorkflow } from "../../hooks/use-workflow";
import { useActiveWorkbench } from "../../lib/active-workbench-context";
import {
  defaultRecurrence,
  formatRecurrence,
  scheduleScopeLabel,
} from "../../lib/schedule-time";

// Create-flow run mode (CL-4335): "once" starts a single immediate run via
// the same POST /workflow-exec/:kind/start path the catalog's "Start" and a
// schedule's "Run now" controls already use — no recurrence is persisted.
// "schedule" is the pre-existing recurring-schedule create path.
export type CreateRunMode = "once" | "schedule";

export type ConnectedNewWorkflowProps = {
  catalogEntries: readonly WorkflowCatalogEntry[];
  schedules: readonly ScheduledTrigger[];
  /** When set, show the create form for this kind; otherwise the kind picker. */
  selectedKind: string | null;
  onSelectKind: (kind: string | null) => void;
  onCreated: (scheduleId: string) => void;
  onRunStarted: (runId: string) => void;
  onCancel: () => void;
};

function productLabel(entry: WorkflowCatalogEntry): string {
  if (entry.kind === HEARTBEAT_WORKFLOW_KIND) {
    return entry.label || "Morning brief";
  }
  return entry.label;
}

function alreadyOnLabel(personal: number, tenant: number): string | undefined {
  if (personal === 0 && tenant === 0) return undefined;
  const parts: string[] = [];
  if (personal > 0) parts.push(`Mine ${personal}`);
  if (tenant > 0) parts.push(`Everyone ${tenant}`);
  return parts.join(" · ");
}

function RunModeSelector({
  mode,
  onChange,
}: {
  mode: CreateRunMode;
  onChange: (mode: CreateRunMode) => void;
}) {
  const options: { value: CreateRunMode; label: string; hint: string }[] = [
    {
      value: "once",
      label: "Run once",
      hint: "A single run, right now",
    },
    {
      value: "schedule",
      label: "Schedule",
      hint: "Repeats on a cadence",
    },
  ];
  return (
    <fieldset
      className="mb-4"
      role="radiogroup"
      aria-label="Run mode"
      data-testid="run-mode-selector"
    >
      <legend className="mb-1.5 text-xs font-semibold uppercase tracking-[0.05em] text-text-3">
        How should this run
      </legend>
      <div className="flex flex-col gap-1.5 sm:flex-row sm:gap-2">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={mode === opt.value}
            data-testid={`run-mode-${opt.value}`}
            onClick={() => onChange(opt.value)}
            className={`flex-1 rounded-[10px] border px-3.5 py-2 text-left text-sm transition-colors ${
              mode === opt.value
                ? "border-orange bg-orange/10 text-text"
                : "border-border text-text-2 hover:border-border-strong"
            }`}
          >
            <span className="block font-semibold">{opt.label}</span>
            <span className="mt-0.5 block text-xs text-text-3">{opt.hint}</span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Full-main create path for unified Workflows: kind picker with already-on
 * badges, then a mode selector (Run once / Schedule, CL-4335) followed by
 * the two-column create form (RunOnceFlow or ScheduleFlow + sticky summary).
 */
export function ConnectedNewWorkflow({
  catalogEntries,
  schedules,
  selectedKind,
  onSelectKind,
  onCreated,
  onRunStarted,
  onCancel,
}: ConnectedNewWorkflowProps) {
  const createSchedule = useCreateSchedule();
  const { activeTenantId } = useActiveWorkbench();
  const startWorkflow = useStartWorkflow(activeTenantId);

  const schedulable = useMemo(() => {
    return catalogEntries
      .filter((e) => e.attachable)
      .slice()
      .sort((a, b) => {
        if (a.kind === HEARTBEAT_WORKFLOW_KIND) return -1;
        if (b.kind === HEARTBEAT_WORKFLOW_KIND) return 1;
        return a.label.localeCompare(b.label);
      });
  }, [catalogEntries]);

  const countsByKind = useMemo(() => {
    const map = new Map<string, { personal: number; tenant: number }>();
    for (const s of schedules) {
      const cur = map.get(s.workflowKind) ?? { personal: 0, tenant: 0 };
      if (s.scope === "tenant") cur.tenant += 1;
      else cur.personal += 1;
      map.set(s.workflowKind, cur);
    }
    return map;
  }, [schedules]);

  const pickerItems: KindPickerItem[] = useMemo(() => {
    return schedulable.map((entry) => {
      const counts = countsByKind.get(entry.kind) ?? {
        personal: 0,
        tenant: 0,
      };
      const badge = alreadyOnLabel(counts.personal, counts.tenant);
      return {
        id: entry.kind,
        label: productLabel(entry),
        description: entry.description ?? "",
        alreadyOn: Boolean(badge),
        ...(badge ? { alreadyOnLabel: badge } : {}),
        kindSlug: entry.kind,
      };
    });
  }, [schedulable, countsByKind]);

  const entry = useMemo(
    () => schedulable.find((e) => e.kind === selectedKind) ?? null,
    [schedulable, selectedKind],
  );

  const [mode, setMode] = useState<CreateRunMode>("once");
  const [draftRecurrence, setDraftRecurrence] =
    useState<ScheduleRecurrence>(defaultRecurrence());
  const [draftScope, setDraftScope] = useState<ScheduleScope>("personal");
  const [draftValues, setDraftValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    if (!entry) return;
    setError(null);
    setMode("once");
    setDraftRecurrence(defaultRecurrence());
    setDraftScope(entry.defaultScope);
    setDraftValues({});
    setFormKey((k) => k + 1);
  }, [entry?.kind]);

  const fieldsFor = (e: WorkflowCatalogEntry): ScheduleFieldMetadata[] =>
    (e.intakeFields ?? []) as ScheduleFieldMetadata[];

  const saveSchedule = async (e: WorkflowCatalogEntry) => {
    setError(null);
    const fields = fieldsFor(e);
    if (!scheduleFieldsComplete(fields, draftValues)) {
      setError("Fill in the required fields.");
      return;
    }
    const formPayload = buildScheduleTriggerPayload(fields, draftValues);
    try {
      const created = await createSchedule.mutateAsync({
        kind: e.kind,
        recurrence: draftRecurrence,
        scope: draftScope,
        payload: formPayload,
      });
      onCreated(created.id);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save the schedule.",
      );
    }
  };

  const runOnce = async (e: WorkflowCatalogEntry) => {
    setError(null);
    const fields = fieldsFor(e);
    if (!scheduleFieldsComplete(fields, draftValues)) {
      setError("Fill in the required fields.");
      return;
    }
    const formPayload = buildScheduleTriggerPayload(fields, draftValues);
    try {
      const started = await startWorkflow.mutateAsync({
        kind: e.kind,
        input: formPayload,
      });
      onRunStarted(started.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the run.");
    }
  };

  if (!entry) {
    return (
      <div
        className="flex h-full min-h-0 flex-col overflow-auto px-4 py-6 sm:px-6"
        data-testid="new-workflow-picker"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-text">
              New Workflow
            </h2>
            <p className="mt-1 text-[13px] text-text-3">
              Choose a workflow to run once or put on a cadence. You can create
              another run for a kind that is already on.
            </p>
          </div>
          <button
            type="button"
            className="shrink-0 text-[12px] text-text-3 underline-offset-2 hover:text-text hover:underline"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
        {pickerItems.length === 0 ? (
          <p className="py-10 text-center text-[13px] text-text-3">
            No schedulable workflows are available in this workspace yet.
          </p>
        ) : (
          <KindPickerShell
            items={pickerItems}
            onSelect={(item) => onSelectKind(item.id)}
          />
        )}
      </div>
    );
  }

  const label = productLabel(entry);
  const fields = fieldsFor(entry);
  const busy =
    mode === "once" ? startWorkflow.isPending : createSchedule.isPending;

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-auto px-4 py-6 sm:px-6"
      data-testid={`new-workflow-create-${entry.kind}`}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <button
            type="button"
            className="mb-1 text-[12px] text-text-3 underline-offset-2 hover:text-text hover:underline"
            onClick={() => onSelectKind(null)}
            data-testid="new-workflow-back-to-kinds"
          >
            ← All workflows
          </button>
          <h2 className="text-[15px] font-semibold text-text">{label}</h2>
          {entry.description ? (
            <p className="mt-1 text-[13px] text-text-3">{entry.description}</p>
          ) : null}
        </div>
        <button
          type="button"
          className="shrink-0 text-[12px] text-text-3 underline-offset-2 hover:text-text hover:underline"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>

      <CreateScheduleFormLayout
        form={
          <div key={formKey} className="min-w-0">
            <RunModeSelector mode={mode} onChange={setMode} />
            {mode === "once" ? (
              <RunOnceFlow
                entry={entry}
                productLabel={label}
                fieldValues={draftValues}
                onFieldValuesChange={setDraftValues}
                fields={fields}
                error={error}
                busy={busy}
                onCancel={onCancel}
                onSave={() => runOnce(entry)}
              />
            ) : (
              <ScheduleFlow
                entry={entry}
                productLabel={label}
                existing={null}
                recurrence={draftRecurrence}
                onRecurrenceChange={setDraftRecurrence}
                scope={draftScope}
                onScopeChange={setDraftScope}
                fieldValues={draftValues}
                onFieldValuesChange={setDraftValues}
                fields={fields}
                error={error}
                busy={busy}
                onCancel={onCancel}
                onSave={() => saveSchedule(entry)}
              />
            )}
          </div>
        }
        summary={
          <CreateScheduleSummary
            rows={
              mode === "once"
                ? [
                    { label: "Kind", value: label },
                    { label: "Runs", value: "Once, right now" },
                  ]
                : [
                    { label: "Kind", value: label },
                    {
                      label: "Cadence",
                      value: formatRecurrence(draftRecurrence),
                    },
                    { label: "Scope", value: scheduleScopeLabel(draftScope) },
                  ]
            }
          />
        }
      />
    </div>
  );
}
