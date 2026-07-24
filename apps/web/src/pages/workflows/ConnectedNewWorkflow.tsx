import { useEffect, useMemo, useState } from "react";
import type {
  ScheduleFieldMetadata,
  ScheduleRecurrence,
  ScheduleScope,
  ScheduledTrigger,
  WorkflowCatalogEntry,
} from "@workbench/shared";
import { HEARTBEAT_WORKFLOW_KIND } from "@workbench/shared";
import {
  CreateScheduleFormLayout,
  CreateScheduleSummary,
  KindPickerShell,
  type KindPickerItem,
} from "@workbench/workflows-ui/react";
import { scheduleFieldsComplete } from "../../components/ScheduleFieldForm";
import { ScheduleFlow } from "../../components/ScheduleFlow";
import { useCreateSchedule } from "../../hooks/use-schedules";
import {
  defaultRecurrence,
  formatRecurrence,
  scheduleScopeLabel,
} from "../../lib/schedule-time";

export type ConnectedNewWorkflowProps = {
  catalogEntries: readonly WorkflowCatalogEntry[];
  schedules: readonly ScheduledTrigger[];
  /** When set, show the create form for this kind; otherwise the kind picker. */
  selectedKind: string | null;
  onSelectKind: (kind: string | null) => void;
  onCreated: (scheduleId: string) => void;
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

/**
 * Full-main create path for unified Workflows: kind picker with already-on
 * badges, then two-column create form (ScheduleFlow + sticky summary).
 */
export function ConnectedNewWorkflow({
  catalogEntries,
  schedules,
  selectedKind,
  onSelectKind,
  onCreated,
  onCancel,
}: ConnectedNewWorkflowProps) {
  const createSchedule = useCreateSchedule();

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

  const [draftRecurrence, setDraftRecurrence] =
    useState<ScheduleRecurrence>(defaultRecurrence());
  const [draftScope, setDraftScope] = useState<ScheduleScope>("personal");
  const [draftValues, setDraftValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    if (!entry) return;
    setError(null);
    setDraftRecurrence(defaultRecurrence());
    setDraftScope(entry.defaultScope);
    setDraftValues({});
    setFormKey((k) => k + 1);
  }, [entry?.kind]);

  const fieldsFor = (e: WorkflowCatalogEntry): ScheduleFieldMetadata[] =>
    (e.intakeFields ?? []) as ScheduleFieldMetadata[];

  const save = async (e: WorkflowCatalogEntry) => {
    setError(null);
    const fields = fieldsFor(e);
    if (!scheduleFieldsComplete(fields, draftValues)) {
      setError("Fill in the required fields.");
      return;
    }
    const formPayload: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.fromProfile) continue;
      const v = draftValues[field.name];
      if (v === undefined || v === null) continue;
      if (typeof v === "string" && v.trim() === "") continue;
      formPayload[field.name] = v;
    }
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
              Choose a workflow to put on a cadence. You can create another
              schedule for a kind that is already on.
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
  const busy = createSchedule.isPending;

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
              onSave={() => save(entry)}
            />
          </div>
        }
        summary={
          <CreateScheduleSummary
            rows={[
              { label: "Kind", value: label },
              { label: "Cadence", value: formatRecurrence(draftRecurrence) },
              { label: "Scope", value: scheduleScopeLabel(draftScope) },
            ]}
          />
        }
      />
    </div>
  );
}
