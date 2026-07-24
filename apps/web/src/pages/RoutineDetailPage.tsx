import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import {
  buildScheduleTriggerPayload,
  HEARTBEAT_WORKFLOW_KIND,
  type ScheduleFieldMetadata,
  type ScheduleRecurrence,
  type ScheduledTrigger,
  type ScheduleScope,
  type WorkflowCatalogEntry,
} from "@workbench/shared";
import { AppPageChromeRow, Button } from "@workbench/ui";
import { getWorkflowsCatalog } from "../lib/hub-api";
import {
  useDeleteSchedule,
  useMeSchedules,
  useUpdateSchedule,
} from "../hooks/use-schedules";
import { scheduleFieldsComplete } from "../components/ScheduleFieldForm";
import { ScheduleFlow } from "../components/ScheduleFlow";
import { useSetPageChrome, useSetPageChromeLeading } from "../lib/page-chrome";
import { formatLastFiredAt, formatNextFire } from "../lib/schedule-time";
import { scheduleRunDeepLink } from "../lib/schedule-run-link";
import { statusLabel } from "../lib/workflow-run-status";

function CenteredNotice({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-6 text-center text-sm text-text-2">
      {children}
    </div>
  );
}

/** Recent fires for this specific schedule, newest first, each linking to its
 * run when the run record is still resolvable (CL-4267, moved to the
 * schedule's own detail page in CL-4277 so two schedules of the same kind
 * each show their own history). */
function RunHistory({ existing }: { existing: ScheduledTrigger }) {
  return (
    <div
      className="rounded-xl border border-border bg-surface p-4"
      data-testid={`run-history-${existing.id}`}
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
          Not yet fired — the scheduler hasn&rsquo;t triggered this routine yet.
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
 * @deprecated Not routed. Member `/routines/:id` redirects to
 * `/workflows?schedule=:id`. Kept for historical unit tests only — use
 * `ConnectedScheduleInspector` on `WorkflowsPage` for the live surface.
 *
 * Former schedule detail: id-keyed edit (`ScheduleFlow`) + run history for one
 * schedule (never by kind). No dedicated single-schedule endpoint exists; the
 * schedule is derived from `useMeSchedules()`.
 */
export function RoutineDetailPage() {
  const { id } = useParams<{ id: string }>();
  // Remount on id change so the edit-draft state below always initializes
  // fresh from the schedule the URL now points at, with no effect needed to
  // resync it.
  return <RoutineDetailBody key={id ?? "none"} id={id} />;
}

function RoutineDetailBody({ id }: { id: string | undefined }) {
  const navigate = useNavigate();
  const catalogQuery = useQuery({
    queryKey: ["workflow-catalog"],
    queryFn: () => getWorkflowsCatalog(),
    staleTime: 60_000,
  });
  const schedulesQuery = useMeSchedules();

  const existing: ScheduledTrigger | undefined = schedulesQuery.data?.find(
    (s) => s.id === id,
  );
  const entry: WorkflowCatalogEntry | undefined =
    catalogQuery.data?.entries.find((e) => e.kind === existing?.workflowKind);

  const loading = catalogQuery.isLoading || schedulesQuery.isLoading;
  const loadError = catalogQuery.error ?? schedulesQuery.error;
  const notFound = !loading && !loadError && (!existing || !entry);

  const leadingChrome = useMemo(
    () => (
      <Link
        to="/routines"
        className="inline-flex items-center gap-1.5 text-sm text-text-2 transition-colors hover:text-text"
      >
        <ArrowLeft size={14} aria-hidden />
        Back to Routines
      </Link>
    ),
    [],
  );
  useSetPageChromeLeading(leadingChrome);

  if (loading) return <CenteredNotice>Loading routine…</CenteredNotice>;

  if (loadError) {
    return (
      <CenteredNotice>
        <div className="flex flex-col items-center gap-2">
          <span>Could not load this routine.</span>
          <Link to="/routines" className="text-orange underline">
            Back to Routines
          </Link>
        </div>
      </CenteredNotice>
    );
  }

  if (notFound || !existing || !entry) {
    return (
      <CenteredNotice>
        <div
          className="flex flex-col items-center gap-2"
          data-testid="routine-not-found"
        >
          <span>This routine couldn&rsquo;t be found.</span>
          <Link to="/routines" className="text-orange underline">
            Back to Routines
          </Link>
        </div>
      </CenteredNotice>
    );
  }

  // Only mounts once the schedule and its catalog entry are both loaded, so
  // the edit-draft state below initializes from real data on its very first
  // render rather than an empty pre-load state that a later re-render can't
  // retroactively fill in.
  return (
    <RoutineEditor entry={entry} existing={existing} navigate={navigate} />
  );
}

function RoutineEditor({
  entry,
  existing,
  navigate,
}: {
  entry: WorkflowCatalogEntry;
  existing: ScheduledTrigger;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();

  const fields: ScheduleFieldMetadata[] =
    (entry.intakeFields as ScheduleFieldMetadata[] | undefined) ?? [];

  const [draftRecurrence, setDraftRecurrence] = useState<ScheduleRecurrence>(
    existing.recurrence,
  );
  const [draftScope] = useState<ScheduleScope>(existing.scope);
  const [draftValues, setDraftValues] = useState<Record<string, unknown>>(
    () => {
      const initial: Record<string, unknown> = {};
      for (const f of fields) {
        if (existing.triggerPayload?.[f.name] !== undefined) {
          initial[f.name] = existing.triggerPayload[f.name];
        }
      }
      return initial;
    },
  );
  const [error, setError] = useState<string | null>(null);

  const productLabel =
    entry.kind === HEARTBEAT_WORKFLOW_KIND
      ? entry.label || "Morning brief"
      : entry.label;

  const save = async () => {
    setError(null);
    if (!scheduleFieldsComplete(fields, draftValues)) {
      setError("Fill in the required fields.");
      return;
    }
    const formPayload = buildScheduleTriggerPayload(fields, draftValues);
    try {
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
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save the schedule.",
      );
    }
  };

  const pageChrome = useMemo(
    () => (
      <AppPageChromeRow title={productLabel} titleSize="sm">
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            updateSchedule.mutate({
              id: existing.id,
              enabled: !existing.enabled,
            })
          }
          data-testid="pause-resume-schedule"
        >
          {existing.enabled ? "Pause" : "Resume"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            deleteSchedule.mutate(
              { id: existing.id },
              { onSuccess: () => navigate("/routines") },
            );
          }}
          data-testid="remove-schedule"
        >
          Remove
        </Button>
      </AppPageChromeRow>
    ),
    [existing, productLabel, updateSchedule, deleteSchedule, navigate],
  );
  useSetPageChrome(pageChrome);

  return (
    <div
      className="mx-auto max-w-3xl px-4 py-8"
      data-testid="routine-detail-page"
    >
      <div className="flex flex-col gap-4">
        <ScheduleFlow
          entry={entry}
          productLabel={productLabel}
          existing={existing}
          recurrence={draftRecurrence}
          onRecurrenceChange={setDraftRecurrence}
          scope={draftScope}
          onScopeChange={() => {}}
          fieldValues={draftValues}
          onFieldValuesChange={setDraftValues}
          fields={fields}
          error={error}
          busy={updateSchedule.isPending}
          onCancel={() => navigate("/routines")}
          onSave={save}
        />
        <RunHistory existing={existing} />
      </div>
    </div>
  );
}
