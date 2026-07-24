import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import {
  HEARTBEAT_WORKFLOW_KIND,
  type ScheduleFieldMetadata,
  type ScheduleRecurrence,
  type ScheduledTrigger,
  type ScheduleScope,
  type WorkflowCatalogEntry,
} from "@workbench/shared";
import { AppPageChromeRow, Button, PagePanel } from "@workbench/ui";
import { Plus } from "lucide-react";
import { getWorkflowsCatalog } from "../lib/hub-api";
import { useCreateSchedule, useMeSchedules } from "../hooks/use-schedules";
import { scheduleFieldsComplete } from "../components/ScheduleFieldForm";
import { ScheduleFlow } from "../components/ScheduleFlow";
import { useSetPageChrome } from "../lib/page-chrome";
import {
  defaultRecurrence,
  formatRecurrence,
  scheduleScopeLabel,
} from "../lib/schedule-time";

/**
 * @deprecated Not routed. Member `/routines` redirects to `/workflows`.
 * Kept for historical unit tests only — use `WorkflowsPage` /
 * `ConnectedNewWorkflow` for the live surface.
 *
 * Former Routines home: schedule-driven rows (one per schedule, not per catalog
 * kind). Detail lived at `/routines/:id` (`RoutineDetailPage`).
 */
export function RoutinesPage() {
  const navigate = useNavigate();
  const catalogQuery = useQuery({
    queryKey: ["workflow-catalog"],
    queryFn: () => getWorkflowsCatalog(),
    staleTime: 60_000,
  });
  const schedulesQuery = useMeSchedules();
  const createSchedule = useCreateSchedule();

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

  const entryByKind = useMemo(() => {
    const map = new Map<string, WorkflowCatalogEntry>();
    for (const e of catalogQuery.data?.entries ?? []) {
      map.set(e.kind, e);
    }
    return map;
  }, [catalogQuery.data?.entries]);

  const schedules = schedulesQuery.data ?? [];

  const [pickerOpen, setPickerOpen] = useState(false);
  const [creatingEntry, setCreatingEntry] =
    useState<WorkflowCatalogEntry | null>(null);
  const [draftRecurrence, setDraftRecurrence] =
    useState<ScheduleRecurrence>(defaultRecurrence());
  const [draftScope, setDraftScope] = useState<ScheduleScope>("personal");
  const [draftValues, setDraftValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);

  const fieldsFor = (entry: WorkflowCatalogEntry): ScheduleFieldMetadata[] =>
    (entry.intakeFields ?? []) as ScheduleFieldMetadata[];

  const startCreate = (entry: WorkflowCatalogEntry) => {
    setError(null);
    setPickerOpen(false);
    setCreatingEntry(entry);
    setDraftRecurrence(defaultRecurrence());
    setDraftScope(entry.defaultScope);
    setDraftValues({});
  };

  const closeCreate = () => {
    setCreatingEntry(null);
    setError(null);
  };

  const save = async (entry: WorkflowCatalogEntry) => {
    setError(null);
    const fields = fieldsFor(entry);
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
      await createSchedule.mutateAsync({
        kind: entry.kind,
        recurrence: draftRecurrence,
        scope: draftScope,
        payload: formPayload,
      });
      closeCreate();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save the schedule.",
      );
    }
  };

  const loading = catalogQuery.isLoading || schedulesQuery.isLoading;
  const loadError = catalogQuery.error ?? schedulesQuery.error;
  const busy = createSchedule.isPending;

  const pageChrome = useMemo(
    () => (
      <AppPageChromeRow title="Routines" titleSize="sm">
        <Button
          type="button"
          variant="primary"
          onClick={() => {
            setError(null);
            setCreatingEntry(null);
            setPickerOpen((open) => !open);
          }}
          className="flex items-center gap-[7px] px-[14px] py-[7px] text-[12.5px]"
          data-testid="new-routine-button"
        >
          <Plus size={16} />
          New routine
        </Button>
      </AppPageChromeRow>
    ),
    [],
  );
  useSetPageChrome(pageChrome);

  return (
    <PagePanel>
      <div
        className="flex-1 px-4 pb-10 pt-4 sm:px-7"
        data-testid="routines-page"
      >
        <p className="mb-4 text-[13px] text-text-3">
          Workflows on a cadence. Open a routine to edit it or see its run
          history.
        </p>

        {loading ? (
          <p className="py-10 text-[13px] text-text-3">Loading routines…</p>
        ) : null}
        {loadError ? (
          <p className="py-10 text-[13px] text-danger" role="alert">
            {loadError instanceof Error
              ? loadError.message
              : "Could not load routines."}
          </p>
        ) : null}

        {pickerOpen ? (
          <div
            className="mb-4 rounded-xl border border-border bg-surface p-4"
            data-testid="routine-picker"
          >
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.05em] text-text-3">
              Choose a workflow to schedule
            </p>
            <ul className="flex flex-col gap-1.5">
              {schedulable.map((entry) => (
                <li key={entry.kind}>
                  <button
                    type="button"
                    className="w-full rounded-[10px] border border-border px-3 py-2 text-left text-sm text-text hover:bg-page"
                    onClick={() => startCreate(entry)}
                    data-testid={`routine-picker-option-${entry.kind}`}
                  >
                    {entry.kind === HEARTBEAT_WORKFLOW_KIND
                      ? entry.label || "Morning brief"
                      : entry.label}
                  </button>
                </li>
              ))}
              {schedulable.length === 0 ? (
                <li className="text-sm text-text-3">
                  No schedulable workflows are available in this workspace
                  yet.
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}

        {creatingEntry ? (
          <div
            className="mb-4 rounded-xl border border-border bg-surface p-4"
            data-testid={`routine-row-new-${creatingEntry.kind}`}
          >
            <ScheduleFlow
              entry={creatingEntry}
              productLabel={
                creatingEntry.kind === HEARTBEAT_WORKFLOW_KIND
                  ? creatingEntry.label || "Morning brief"
                  : creatingEntry.label
              }
              existing={null}
              recurrence={draftRecurrence}
              onRecurrenceChange={setDraftRecurrence}
              scope={draftScope}
              onScopeChange={setDraftScope}
              fieldValues={draftValues}
              onFieldValuesChange={setDraftValues}
              fields={fieldsFor(creatingEntry)}
              error={error}
              busy={busy}
              onCancel={closeCreate}
              onSave={() => save(creatingEntry)}
            />
          </div>
        ) : null}

        {!loading && !loadError && schedules.length === 0 && !creatingEntry ? (
          <p className="py-10 text-[13px] text-text-3">
            No routines yet. Use "New routine" to put a workflow on a cadence.
          </p>
        ) : null}

        <ul className="flex flex-col gap-3">
          {schedules.map((existing: ScheduledTrigger) => {
            const entry = entryByKind.get(existing.workflowKind);
            if (!entry) return null;
            const productLabel =
              entry.kind === HEARTBEAT_WORKFLOW_KIND
                ? entry.label || "Morning brief"
                : entry.label;

            return (
              <li key={existing.id}>
                <div
                  role="button"
                  tabIndex={0}
                  data-testid={`routine-row-${existing.id}`}
                  onClick={() => navigate(`/routines/${existing.id}`)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    navigate(`/routines/${existing.id}`);
                  }}
                  className="flex cursor-pointer flex-wrap items-start justify-between gap-3 rounded-xl border border-border bg-surface p-4 hover:bg-page"
                >
                  <div className="min-w-0 flex-1">
                    <h2 className="text-base font-semibold text-text">
                      {productLabel}
                    </h2>
                    {existing.name !== entry.kind ? (
                      <p className="mt-0.5 text-xs font-medium text-text-3">
                        {existing.name}
                      </p>
                    ) : null}
                    {entry.description ? (
                      <p className="mt-1 text-sm text-text-2">
                        {entry.description}
                      </p>
                    ) : null}
                    <p className="mt-2 text-xs text-text-3">
                      {existing.enabled
                        ? `Scheduled · ${formatRecurrence(existing.recurrence)} · ${scheduleScopeLabel(existing.scope)}`
                        : `Paused · ${scheduleScopeLabel(existing.scope)}`}
                    </p>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </PagePanel>
  );
}
