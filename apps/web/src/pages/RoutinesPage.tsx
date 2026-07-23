import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  HEARTBEAT_WORKFLOW_KIND,
  type ScheduleFieldMetadata,
  type ScheduleRecurrence,
  type ScheduledTrigger,
  type ScheduleScope,
  type WorkflowCatalogEntry,
} from "@workbench/shared";
import { AppPageChromeRow, Badge } from "@workbench/ui";
import { Link } from "react-router";
import { getWorkflowsCatalog } from "../lib/hub-api";
import { useSetPageChrome } from "../lib/page-chrome";
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
  formatLastFiredAt,
  formatNextFire,
  formatRecurrence,
  scheduleScopeLabel,
} from "../lib/schedule-time";
import { scheduleRunDeepLink } from "../lib/schedule-run-link";
import { statusLabel } from "../lib/workflow-run-status";

/** Recent fires for one routine, newest first, each linking to its run when
 * the run record is still resolvable. Only rendered for an already-scheduled
 * routine — a routine that has never been scheduled has no history to show. */
function RunHistory({ existing }: { existing: ScheduledTrigger }) {
  return (
    <div
      className="mt-4 border-t border-border pt-4"
      data-testid={`run-history-${existing.workflowKind}`}
    >
      <div className="mb-2 flex items-center justify-between text-xs">
        <h3 className="font-semibold uppercase tracking-[0.05em] text-text-3">
          Run history
        </h3>
        <span className="text-text-3">
          Next: {formatNextFire(existing.nextFireAt, existing.enabled)}
        </span>
      </div>
      {existing.recentFires.length === 0 ? (
        <p className="text-sm text-text-3">
          Not yet fired — the scheduler hasn&rsquo;t triggered this routine
          yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {existing.recentFires.map((fire) => (
            <li
              key={`${fire.runId}-${fire.firedAt}`}
              className="flex items-center justify-between gap-3 text-sm"
            >
              {fire.status === "unknown" ? (
                <span className="text-text-3">
                  {formatLastFiredAt(fire.firedAt)}
                </span>
              ) : (
                <Link
                  to={scheduleRunDeepLink(fire.status, fire.runId)}
                  className="font-medium text-text-2 underline-offset-2 hover:underline"
                >
                  {formatLastFiredAt(fire.firedAt)}
                </Link>
              )}
              <span className="shrink-0 text-xs text-text-3">
                {statusLabel(fire.status)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Routines home (CL-3862, renamed from Automations in CL-4211): a scannable
 * list of schedulable workflows — cadence, scope, and status legible without
 * opening a row — where opening a row expands the multi-step schedule
 * create/edit walk (CL-4263's `ScheduleFlow`, Open → Recurrence → Inputs →
 * Availability) and run history in place (CL-4267). Morning brief
 * (heartbeat) uses product naming from the catalog label.
 */
export function RoutinesPage() {
  const chrome = useMemo(
    () => (
      <AppPageChromeRow
        title="Routines"
        titleSize="sm"
        subtitle="Workflows on a recurring cadence"
        className="[&_h1]:text-[20px] [&_h1]:tracking-[-0.01em]"
      />
    ),
    [],
  );
  useSetPageChrome(chrome);

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

  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());

  useEffect(() => {
    if (expandedKind === null) return;
    const node = rowRefs.current.get(expandedKind);
    node?.scrollIntoView({ block: "nearest" });
  }, [expandedKind]);

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

  const toggleEditor = (
    entry: WorkflowCatalogEntry,
    existing?: ScheduledTrigger,
  ) => {
    if (expandedKind === entry.kind) {
      closeEditor();
    } else {
      openEditor(entry, existing);
    }
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
    <div className="h-full overflow-y-auto" data-testid="routines-page">
      <div className="mx-auto max-w-3xl px-4 py-8">
        {loading ? (
          <p className="text-sm text-text-3">Loading routines…</p>
        ) : null}
        {loadError ? (
          <p className="text-sm text-danger" role="alert">
            {loadError instanceof Error
              ? loadError.message
              : "Could not load routines."}
          </p>
        ) : null}

        {!loading && !loadError && schedulable.length === 0 ? (
          <p className="text-sm text-text-3">
            No schedulable workflows are available in this workspace yet.
          </p>
        ) : null}

        {!loading && !loadError && schedulable.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface">
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
                  ref={(node) => {
                    if (node) rowRefs.current.set(entry.kind, node);
                    else rowRefs.current.delete(entry.kind);
                  }}
                  data-testid={`routine-row-${entry.kind}`}
                >
                  <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-label={
                        expanded
                          ? `Collapse ${productLabel}`
                          : `Expand ${productLabel}`
                      }
                      onClick={() => toggleEditor(entry, existing)}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-text-3 hover:bg-page hover:text-text"
                    >
                      <span
                        aria-hidden="true"
                        className={`inline-block transition-transform ${expanded ? "rotate-90" : ""}`}
                      >
                        ›
                      </span>
                    </button>

                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-sm font-semibold text-text">
                        {productLabel}
                      </h2>
                      {entry.description ? (
                        <p className="truncate text-xs text-text-3">
                          {entry.description}
                        </p>
                      ) : null}
                    </div>

                    <div className="w-32 shrink-0 text-xs text-text-2">
                      {existing ? formatRecurrence(existing.recurrence) : "—"}
                    </div>

                    <div className="w-24 shrink-0 text-xs text-text-2">
                      {existing ? scheduleScopeLabel(existing.scope) : "—"}
                    </div>

                    <div className="w-24 shrink-0">
                      {existing ? (
                        <Badge
                          tone={existing.enabled ? "positive" : "neutral"}
                        >
                          {existing.enabled ? "Active" : "Paused"}
                        </Badge>
                      ) : (
                        <Badge tone="neutral">Not scheduled</Badge>
                      )}
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-2">
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
                            onClick={() => toggleEditor(entry, existing)}
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
                          onClick={() => toggleEditor(entry)}
                          data-testid={`schedule-${entry.kind}`}
                        >
                          Schedule
                        </button>
                      )}
                    </div>
                  </div>

                  {expanded ? (
                    <>
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
                      {existing ? <RunHistory existing={existing} /> : null}
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
