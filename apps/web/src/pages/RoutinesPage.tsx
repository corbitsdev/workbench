import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  HEARTBEAT_WORKFLOW_KIND,
  type ScheduleFieldMetadata,
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
import {
  ScheduleFieldForm,
  scheduleFieldsComplete,
} from "../components/ScheduleFieldForm";
import {
  formatUtcHourLocal,
  scheduleScopeLabel,
  utcHourOptions,
} from "../lib/schedule-time";

/**
 * Routines home (CL-3862, renamed from Automations in CL-4211): lists
 * schedulable workflows with schedule status and manage-in-place create/edit
 * using schema-driven field forms (CL-3861).
 * Morning brief (heartbeat) uses product naming from the catalog label.
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
  const [draftHour, setDraftHour] = useState(14);
  const [draftScope, setDraftScope] = useState<ScheduleScope>("personal");
  const [draftValues, setDraftValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);

  const openEditor = (
    entry: WorkflowCatalogEntry,
    existing?: ScheduledTrigger,
  ) => {
    setError(null);
    setExpandedKind(entry.kind);
    setDraftHour(existing?.hourUtc ?? 14);
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
    // Only form-owned keys. Hour-only edits on empty-intake workflows must not
    // replace triggerPayload (e.g. heartbeat `reason: scheduled-heartbeat`).
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
          hourUtc: draftHour,
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
          hourUtc: draftHour,
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
  const hourOptions = utcHourOptions();

  return (
    <div className="mx-auto max-w-3xl px-4 py-8" data-testid="routines-page">
      <LibraryPageHeader title="Routines" />
      <p className="mt-2 text-sm text-text-2">
        Workflows you can put on a daily cadence. Status and manage in place —
        no separate settings hop.
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
                        ? `Scheduled · ${formatUtcHourLocal(existing.hourUtc)} · ${scheduleScopeLabel(existing.scope)}`
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
                <div
                  className="mt-4 border-t border-border pt-4"
                  data-testid={`schedule-editor-${entry.kind}`}
                >
                  <label
                    htmlFor={`hour-${entry.kind}`}
                    className="mb-1 block text-xs font-semibold uppercase tracking-[0.05em] text-text-3"
                  >
                    Daily time (local)
                  </label>
                  <select
                    id={`hour-${entry.kind}`}
                    value={draftHour}
                    onChange={(e) => setDraftHour(Number(e.target.value))}
                    className="mb-3 w-full max-w-xs rounded-[10px] border border-border bg-page px-3 py-2 text-sm"
                  >
                    {hourOptions.map((opt) => (
                      <option key={opt.hourUtc} value={opt.hourUtc}>
                        {opt.label}
                      </option>
                    ))}
                  </select>

                  {!existing && entry.allowedScopes.length > 1 ? (
                    <fieldset className="mb-3">
                      <legend className="mb-1.5 text-xs font-semibold uppercase tracking-[0.05em] text-text-3">
                        Who is this for
                      </legend>
                      <div className="flex flex-col gap-1.5">
                        {entry.allowedScopes.map((scope) => (
                          <label
                            key={scope}
                            className="flex cursor-pointer items-start gap-2 text-sm text-text"
                          >
                            <input
                              type="radio"
                              name={`routine-scope-${entry.kind}`}
                              value={scope}
                              checked={draftScope === scope}
                              onChange={() => setDraftScope(scope)}
                              className="mt-0.5 accent-accent"
                            />
                            <span>
                              <span className="font-medium">
                                {scheduleScopeLabel(scope)}
                              </span>
                              <span className="mt-0.5 block text-xs text-text-3">
                                {scope === "tenant"
                                  ? "One shared run for the workspace; outcomes fan out to every member's inbox."
                                  : "Only you own the schedule and receive the outcome."}
                              </span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ) : null}

                  {existing ? (
                    <p className="mb-3 text-xs text-text-3">
                      Scope is set when a schedule is created and can&rsquo;t be
                      changed here — remove this schedule and create a new one
                      to change who it runs for.
                    </p>
                  ) : null}

                  <ScheduleFieldForm
                    fields={fields}
                    values={draftValues}
                    onChange={setDraftValues}
                    idPrefix={`routine-${entry.kind}`}
                  />

                  {error ? (
                    <p className="mt-2 text-sm text-danger" role="alert">
                      {error}
                    </p>
                  ) : null}

                  <div className="mt-4 flex gap-2">
                    <button
                      type="button"
                      className="rounded-[10px] bg-orange px-3.5 py-2 text-sm font-semibold text-white"
                      onClick={() => void save(entry, existing)}
                      disabled={
                        createSchedule.isPending || updateSchedule.isPending
                      }
                    >
                      {existing ? "Save changes" : "Create schedule"}
                    </button>
                    <button
                      type="button"
                      className="rounded-[10px] border border-border px-3.5 py-2 text-sm text-text-2"
                      onClick={closeEditor}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
