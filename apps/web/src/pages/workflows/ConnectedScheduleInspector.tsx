import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link } from "react-router";
import {
  buildScheduleTriggerPayload,
  HEARTBEAT_WORKFLOW_KIND,
  type ScheduleFieldMetadata,
  type ScheduleRecurrence,
  type ScheduledTrigger,
  type WorkflowCatalogEntry,
} from "@workbench/shared";
import { toHumanLabel } from "@workbench/ui";
import {
  InspectorPanelTitle,
  ScheduleInspectorView,
} from "@workbench/workflows-ui/react";
import { scheduleFieldsComplete } from "../../components/ScheduleFieldForm";
import { ScheduleFlow } from "../../components/ScheduleFlow";
import {
  useDeleteSchedule,
  useUpdateSchedule,
} from "../../hooks/use-schedules";
import { useStartWorkflow } from "../../hooks/use-workflow";
import { useActiveWorkbench } from "../../lib/active-workbench-context";
import { scheduleRunDeepLink } from "../../lib/schedule-run-link";
import {
  formatLastFiredAt,
  formatNextFire,
  formatRecurrence,
} from "../../lib/schedule-time";
import { statusLabel } from "../../lib/workflow-run-status";

export type ConnectedScheduleInspectorProps = {
  schedule: ScheduledTrigger;
  catalogEntry?: Pick<
    WorkflowCatalogEntry,
    | "kind"
    | "label"
    | "description"
    | "intakeFields"
    | "allowedScopes"
    | "defaultScope"
    | "attachable"
    | "isFavorite"
    | "stepCount"
    | "pauseCount"
    | "steps"
  >;
  /** Navigate away (or clear selection) after a successful delete. */
  onRemoved?: () => void;
  /** Fired when run-now starts a workflow and returns a run id. */
  onRunStarted?: (runId: string) => void;
};

function productLabelFor(
  entry: { kind: string; label: string } | undefined,
  kind: string,
): string {
  if (!entry) return toHumanLabel(kind);
  if (entry.kind === HEARTBEAT_WORKFLOW_KIND) {
    return entry.label || "Morning brief";
  }
  return entry.label || toHumanLabel(kind);
}

function toCatalogEntry(
  schedule: ScheduledTrigger,
  catalogEntry: ConnectedScheduleInspectorProps["catalogEntry"],
): WorkflowCatalogEntry {
  if (catalogEntry) {
    return {
      kind: catalogEntry.kind,
      label: catalogEntry.label,
      ...(catalogEntry.description !== undefined
        ? { description: catalogEntry.description }
        : {}),
      isFavorite: catalogEntry.isFavorite,
      stepCount: catalogEntry.stepCount,
      pauseCount: catalogEntry.pauseCount,
      steps: catalogEntry.steps,
      attachable: catalogEntry.attachable,
      ...(catalogEntry.intakeFields !== undefined
        ? { intakeFields: catalogEntry.intakeFields }
        : {}),
      allowedScopes: catalogEntry.allowedScopes,
      defaultScope: catalogEntry.defaultScope,
    };
  }
  return {
    kind: schedule.workflowKind,
    label: toHumanLabel(schedule.workflowKind),
    isFavorite: false,
    stepCount: 0,
    pauseCount: 0,
    steps: [],
    attachable: true,
    allowedScopes: [schedule.scope],
    defaultScope: schedule.scope,
  };
}

function RecentFires({ schedule }: { schedule: ScheduledTrigger }) {
  return (
    <div className="mt-1" data-testid={`schedule-run-history-${schedule.id}`}>
      <InspectorPanelTitle>Recent runs</InspectorPanelTitle>
      {schedule.recentFires.length === 0 ? (
        <p className="text-[12.5px] text-text-3">
          Not yet fired — the scheduler hasn&rsquo;t triggered this schedule
          yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {schedule.recentFires.map((fire) => (
            <li
              key={`${fire.runId}-${fire.firedAt}`}
              className="flex items-center justify-between gap-3 text-[12.5px]"
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
              <span className="shrink-0 text-[11px] text-text-3">
                {statusLabel(fire.status)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RemoveScheduleButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="mt-6 border-t border-border pt-4">
      <div className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.05em] text-red">
        Danger zone
      </div>
      <button
        type="button"
        data-testid="remove-schedule"
        disabled={disabled}
        onClick={onClick}
        className="rounded-[7px] border border-red/35 bg-red/10 px-2.5 py-1.5 text-[12px] font-semibold text-red disabled:opacity-50"
      >
        Remove schedule
      </button>
    </div>
  );
}

/**
 * Right-rail schedule inspector for the unified Workflows page: view mode uses
 * `@workbench/workflows-ui/react` `ScheduleInspectorView`; edit mode reuses
 * `ScheduleFlow` (same form as the routines detail page). Mutations go through
 * `useUpdateSchedule` / `useDeleteSchedule`; run-now starts the workflow kind
 * with the schedule's stored trigger payload via `useStartWorkflow`.
 *
 * NOTES: There is no dedicated "fire schedule now" hub endpoint. Run-now calls
 * `POST /workflow-exec/:kind/start` with `input = schedule.triggerPayload`, the
 * same start path as the catalog "run" control — not a scheduler tick.
 */
export function ConnectedScheduleInspector(
  props: ConnectedScheduleInspectorProps,
) {
  // Remount on schedule id change so edit drafts always initialize from the
  // schedule the selection now points at.
  return <ConnectedScheduleInspectorBody key={props.schedule.id} {...props} />;
}

function ConnectedScheduleInspectorBody({
  schedule,
  catalogEntry,
  onRemoved,
  onRunStarted,
}: ConnectedScheduleInspectorProps) {
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();
  const { activeTenantId } = useActiveWorkbench();
  const startWorkflow = useStartWorkflow(activeTenantId);

  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const viewRootRef = useRef<HTMLDivElement>(null);

  const entry = useMemo(
    () => toCatalogEntry(schedule, catalogEntry),
    [schedule, catalogEntry],
  );
  const fields: ScheduleFieldMetadata[] =
    (entry.intakeFields as ScheduleFieldMetadata[] | undefined) ?? [];
  const productLabel = productLabelFor(entry, schedule.workflowKind);

  const [draftRecurrence, setDraftRecurrence] = useState<ScheduleRecurrence>(
    schedule.recurrence,
  );
  const [draftName, setDraftName] = useState<string>(
    schedule.name !== schedule.workflowKind ? schedule.name : "",
  );
  const [draftValues, setDraftValues] = useState<Record<string, unknown>>(
    () => {
      const initial: Record<string, unknown> = {};
      for (const f of fields) {
        if (schedule.triggerPayload?.[f.name] !== undefined) {
          initial[f.name] = schedule.triggerPayload[f.name];
        }
      }
      return initial;
    },
  );

  // Package action buttons have no data-testid props; stamp the hooks the
  // Workflows rail tests rely on without forking ScheduleInspectorView.
  useLayoutEffect(() => {
    if (editing) return;
    const root = viewRootRef.current;
    if (!root) return;
    for (const btn of root.querySelectorAll("button")) {
      const label = btn.textContent?.trim() ?? "";
      if (label === "Edit") {
        btn.setAttribute("data-testid", "schedule-edit");
      } else if (label === "Run now") {
        btn.setAttribute("data-testid", "schedule-run-now");
      } else if (label === "Pause" || label === "Resume") {
        btn.setAttribute("data-testid", "pause-resume-schedule");
      }
    }
  }, [editing, schedule.enabled, startWorkflow.isPending]);

  const handleTogglePause = () => {
    setError(null);
    updateSchedule
      .mutateAsync({ id: schedule.id, enabled: !schedule.enabled })
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : "Could not update the schedule.",
        );
      });
  };

  const handleRemove = () => {
    setError(null);
    deleteSchedule.mutate(
      { id: schedule.id },
      {
        onSuccess: () => onRemoved?.(),
        onError: (err) => {
          setError(
            err instanceof Error
              ? err.message
              : "Could not remove the schedule.",
          );
        },
      },
    );
  };

  const handleRunNow = () => {
    if (startWorkflow.isPending) return;
    setError(null);
    startWorkflow
      .mutateAsync({
        kind: schedule.workflowKind,
        input: schedule.triggerPayload ?? {},
      })
      .then((res) => {
        if (res?.runId) onRunStarted?.(res.runId);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : "Could not start the workflow.",
        );
      });
  };

  const handleSave = async () => {
    setError(null);
    if (!scheduleFieldsComplete(fields, draftValues)) {
      setError("Fill in the required fields.");
      return;
    }
    const formPayload = buildScheduleTriggerPayload(fields, draftValues);
    const trimmedName = draftName.trim();
    try {
      await updateSchedule.mutateAsync({
        id: schedule.id,
        recurrence: draftRecurrence,
        name: trimmedName ? trimmedName : schedule.workflowKind,
        ...(fields.length > 0
          ? {
              payload: {
                ...Object.fromEntries(
                  Object.entries(schedule.triggerPayload ?? {}).filter(
                    ([key]) => !(key in formPayload),
                  ),
                ),
                ...formPayload,
              },
            }
          : {}),
      });
      setEditing(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save the schedule.",
      );
    }
  };

  if (editing) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col overflow-auto px-4 py-3"
        data-testid="connected-schedule-inspector-edit"
      >
        <ScheduleFlow
          entry={entry}
          productLabel={productLabel}
          existing={schedule}
          recurrence={draftRecurrence}
          onRecurrenceChange={setDraftRecurrence}
          scope={schedule.scope}
          onScopeChange={() => {
            /* Scope is fixed after create — ScheduleFlow hides the control when existing is set. */
          }}
          fieldValues={draftValues}
          onFieldValuesChange={setDraftValues}
          fields={fields}
          error={error}
          busy={updateSchedule.isPending}
          name={draftName}
          onNameChange={setDraftName}
          onCancel={() => {
            setError(null);
            setDraftRecurrence(schedule.recurrence);
            setDraftName(
              schedule.name !== schedule.workflowKind ? schedule.name : "",
            );
            setEditing(false);
          }}
          onSave={handleSave}
        />
        <RemoveScheduleButton
          onClick={handleRemove}
          disabled={deleteSchedule.isPending}
        />
      </div>
    );
  }

  const displayName =
    schedule.name !== schedule.workflowKind ? schedule.name : undefined;

  const recentRuns: ReactNode = (
    <>
      <RecentFires schedule={schedule} />
      <RemoveScheduleButton
        onClick={handleRemove}
        disabled={deleteSchedule.isPending}
      />
      {error ? (
        <p className="mt-3 text-[12.5px] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );

  return (
    <div
      ref={viewRootRef}
      className="contents"
      data-testid="connected-schedule-inspector"
    >
      <ScheduleInspectorView
        className="h-full"
        enabled={schedule.enabled}
        scope={schedule.scope}
        title={productLabel}
        {...(entry.description !== undefined
          ? { description: entry.description }
          : {})}
        cadence={formatRecurrence(schedule.recurrence)}
        next={formatNextFire(schedule.nextFireAt, schedule.enabled)}
        last={formatLastFiredAt(schedule.recentFires[0]?.firedAt ?? null)}
        {...(displayName !== undefined ? { name: displayName } : {})}
        kindSlug={schedule.workflowKind}
        scheduleId={schedule.id}
        recentRuns={recentRuns}
        onEdit={() => {
          setError(null);
          setDraftRecurrence(schedule.recurrence);
          setDraftName(
            schedule.name !== schedule.workflowKind ? schedule.name : "",
          );
          setEditing(true);
        }}
        onRunNow={handleRunNow}
        onTogglePause={handleTogglePause}
        runNowLabel={startWorkflow.isPending ? "Starting…" : "Run now"}
      />
    </div>
  );
}
