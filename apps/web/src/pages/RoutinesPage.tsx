import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  HEARTBEAT_WORKFLOW_KIND,
  type ScheduleFieldMetadata,
  type ScheduleRecurrence,
  type ScheduledTrigger,
  type ScheduleScope,
  type WorkflowCatalogEntry,
} from "@workbench/shared";
import { LibraryPageHeader } from "@workbench/ui";
import { getWorkflowsCatalog } from "../lib/hub-api";
import {
  useCreateSchedule,
  useDeleteSchedule,
  useMeSchedules,
  useUpdateSchedule,
} from "../hooks/use-schedules";
import { scheduleFieldsComplete } from "../components/ScheduleFieldForm";
import { ScheduleFlow } from "../components/ScheduleFlow";
import {
  defaultRecurrence,
  formatRecurrence,
  scheduleScopeLabel,
} from "../lib/schedule-time";

/**
 * Routines home (CL-3862, renamed from Automations in CL-4211): lists
 * schedulable workflows with schedule status and manage-in-place create/edit
 * using schema-driven field forms (CL-3861) and the multi-step schedule walk
 * (CL-4263). Morning brief (heartbeat) uses product naming from the catalog label.
 */
export function RoutinesPage() {
  const catalogQuery = useQuery({
    queryKey: ["workflow-catalog"],
    queryFn: () => getWorkflowsCatalog(),
    staleTime: 60_000,
  });
  const schedulesQuery = useMeSchedules();
  const createSchedule = useCreateSchedule();
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();

  const schedulable = useMemo(() => {
    const entries = catalogQuery.data?.entries ?? [];
    return entries
      .filter((e) => e.attachable)
      .slice()
      .sort((a, b) => {
        if (a.kind === HEARTBEAT_WORKFLOW_KIND) return -1;
        if (b.kind === HEARTBEAT_WORKFLOW_KIND) return 1;
        return a.label.localeCompare(b.label);
      });
  }, [catalogQuery.data?.entries]);

  const scheduleByKind = useMemo(() => {
    const map = new Map<string, ScheduledTrigger>();
    for (const s of schedulesQuery.data ?? []) {
      map.set(s.workflowKind, s);
    }
    return map;
  }, [schedulesQuery.data]);

  const [expandedKind, setExpandedKind] = useState<string | null>(null);
  const [draftRecurrence, setDraftRecurrence] =
    useState<ScheduleRecurrence>(defaultRecurrence());
  const [draftScope, setDraftScope] = useState<ScheduleScope>("personal");
  const [draftValues, setDraftValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);

  const openEditor = (
    entry: WorkflowCatalogEntry,
    existing?: ScheduledTrigger,
  ) => {
    setError(null);
    setExpandedKind(entry.kind);
    setDraftRecurrence(existing?.recurrence ?? defaultRecurrence());
    setDraftScope(existing?.scope ?? entry.defaultScope);
    const fields = (entry.intakeFields ?? []) as ScheduleFieldMetadata[];
    const initial: Record<string, unknown> = {};
    for (const f of fields) {
      if (existing?.triggerPayload?.[f.name] !== undefined) {
        initial[f.name] = existing.triggerPayload[f.name];
      }
    }
    setDraftValues(initial);
  };

  const closeEditor = () => {
    setExpandedKind(null);
    setError(null);
  };

  const fieldsFor = (entry: WorkflowCatalogEntry): ScheduleFieldMetadata[] =>
    (entry.intakeFields ?? []) as ScheduleFieldMetadata[];

  const save = async (
    entry: WorkflowCatalogEntry,
    existing?: ScheduledTrigger,
  ) => {
    setError(null);
    const fields = fieldsFor(entry);
    if (!scheduleFieldsComplete(fields, draftValues)) {
      setError("Fill in the required fields.");
      return;
    }
    // Only form-owned keys. Recurrence-only edits on empty-intake workflows must
    // not replace triggerPayload (e.g. heartbeat `reason: scheduled-heartbeat`).
    const formPayload: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.fromProfile) continue;
      const v = draftValues[field.name];
      if (v === undefined || v === null) continue;
      if (typeof v === "string" && v.trim() === "") continue;
      formPayload[field.name] = v;
    }
    try {
      if (existing) {
        await updateSchedule.mutateAsync({
          id: existing.id,
          recurrence: draftRecurrence,
          ...(fields.length > 0
            ? {
                payload: {
                  ...Object.fromEntries(
                    Object.entries(existing.triggerPayload ?? {}).filter(
                      ([key]) => !(key in formPayload),
                    ),
                  ),
                  ...formPayload,
                },
              }
            : {}),
        });
      } else {
        await createSchedule.mutateAsync({
          kind: entry.kind,
          recurrence: draftRecurrence,
          scope: draftScope,
          payload: formPayload,
        });
      }
      closeEditor();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save the schedule.",
      );
    }
  };

  const loading = catalogQuery.isLoading || schedulesQuery.isLoading;
  const loadError = catalogQuery.error ?? schedulesQuery.error;
  const busy = createSchedule.isPending || updateSchedule.isPending;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8" data-testid="routines-page">
      <LibraryPageHeader title="Routines" />
      <p className="mt-2 text-sm text-text-2">
        Workflows you can put on a cadence. Status and manage in place — no
        separate settings hop.
      </p>

      {loading ? (
        <p className="mt-6 text-sm text-text-3">Loading routines…</p>
      ) : null}
      {loadError ? (
        <p className="mt-6 text-sm text-danger" role="alert">
          {loadError instanceof Error
            ? loadError.message
            : "Could not load routines."}
        </p>
      ) : null}

      {!loading && !loadError && schedulable.length === 0 ? (
        <p className="mt-6 text-sm text-text-3">
          No schedulable workflows are available in this workspace yet.
        </p>
      ) : null}

      <ul className="mt-6 flex flex-col gap-3">
        {schedulable.map((entry) => {
          const existing = scheduleByKind.get(entry.kind);
          const expanded = expandedKind === entry.kind;
          const fields = fieldsFor(entry);
          const productLabel =
            entry.kind === HEARTBEAT_WORKFLOW_KIND
              ? entry.label || "Morning brief"
              : entry.label;

          return (
            <li
              key={entry.kind}
              className="rounded-xl border border-border bg-surface p-4"
              data-testid={`routine-row-${entry.kind}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="text-base font-semibold text-text">
                    {productLabel}
                  </h2>
                  {entry.description ? (
                    <p className="mt-1 text-sm text-text-2">
                      {entry.description}
                    </p>
                  ) : null}
                  <p className="mt-2 text-xs text-text-3">
                    {existing
                      ? existing.enabled
                        ? `Scheduled · ${formatRecurrence(existing.recurrence)} · ${scheduleScopeLabel(existing.scope)}`
                        : `Paused · ${scheduleScopeLabel(existing.scope)}`
                      : "Not scheduled"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {existing ? (
                    <>
                      <button
                        type="button"
                        className="rounded-[10px] border border-border px-3 py-1.5 text-sm font-medium text-text-2 hover:bg-page"
                        onClick={() =>
                          updateSchedule.mutate({
                            id: existing.id,
                            enabled: !existing.enabled,
                          })
                        }
                      >
                        {existing.enabled ? "Pause" : "Resume"}
                      </button>
                      <button
                        type="button"
                        className="rounded-[10px] border border-border px-3 py-1.5 text-sm font-medium text-text-2 hover:bg-page"
                        onClick={() => openEditor(entry, existing)}
                        data-testid={`edit-schedule-${entry.kind}`}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="rounded-[10px] border border-border px-3 py-1.5 text-sm font-medium text-danger hover:bg-page"
                        onClick={() =>
                          deleteSchedule.mutate({ id: existing.id })
                        }
                      >
                        Remove
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="rounded-[10px] bg-orange px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90"
                      onClick={() => openEditor(entry)}
                      data-testid={`schedule-${entry.kind}`}
                    >
                      Schedule
                    </button>
                  )}
                </div>
              </div>

              {expanded ? (
                <ScheduleFlow
                  entry={entry}
                  productLabel={productLabel}
                  existing={existing ?? null}
                  recurrence={draftRecurrence}
                  onRecurrenceChange={setDraftRecurrence}
                  scope={draftScope}
                  onScopeChange={setDraftScope}
                  fieldValues={draftValues}
                  onFieldValuesChange={setDraftValues}
                  fields={fields}
                  error={error}
                  busy={busy}
                  onCancel={closeEditor}
                  onSave={() => save(entry, existing)}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
