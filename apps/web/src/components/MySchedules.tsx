import { useMemo } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { ScheduledTrigger } from "@workbench/shared";
import { ConfirmButton } from "@workbench/ui";
import {
  useDeleteSchedule,
  useMeSchedules,
  useUpdateSchedule,
} from "../hooks/use-schedules";
import { useWorkflowsCatalog } from "../hooks/use-workflows-catalog";
import { RecurrenceAmountInput } from "./RecurrenceAmountInput";
import {
  amountUnitFromInterval,
  anchorToLocalTimeInputValue,
  formatLastFiredAt,
  formatNextFire,
  formatRecurrence,
  intervalFromAmountUnit,
  localTimeInputValueToAnchor,
  onlyDailyAllowedForKind,
  scheduleScopeLabel,
  type RecurrenceUnit,
} from "../lib/schedule-time";
import { scheduleRunDeepLink } from "../lib/schedule-run-link";

const RECURRENCE_UNIT_OPTIONS: { value: RecurrenceUnit; label: string }[] = [
  { value: "minutes", label: "minutes" },
  { value: "hours", label: "hours" },
  { value: "days", label: "days" },
  { value: "weeks", label: "weeks" },
];

export interface MySchedulesProps {
  tenantId: string | null;
  /** Omit the section heading when embedded under Settings. */
  embedded?: boolean;
}

function EnabledToggle({
  enabled,
  disabled,
  label,
  onToggle,
}: {
  enabled: boolean;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={enabled ? `Pause ${label}` : `Resume ${label}`}
      disabled={disabled}
      onClick={onToggle}
      className={`relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong disabled:opacity-50 ${
        enabled ? "bg-orange" : "bg-border-strong"
      }`}
    >
      <motion.span
        className="absolute h-[16px] w-[16px] rounded-full bg-white shadow-sm"
        animate={{ left: enabled ? 19 : 3 }}
        transition={
          reduceMotion
            ? { duration: 0 }
            : { type: "spring", stiffness: 500, damping: 32 }
        }
      />
    </button>
  );
}

function RecurrenceSelect({
  recurrence,
  disabled,
  label,
  kind,
  onChange,
}: {
  recurrence: ScheduledTrigger["recurrence"];
  disabled: boolean;
  label: string;
  kind: string;
  onChange: (recurrence: ScheduledTrigger["recurrence"]) => void;
}) {
  const dailyOnly = onlyDailyAllowedForKind(kind);
  const { amount, unit } = amountUnitFromInterval(recurrence.intervalMinutes);

  const updateInterval = (nextAmount: number, nextUnit: RecurrenceUnit) => {
    onChange({
      ...recurrence,
      intervalMinutes: intervalFromAmountUnit(nextAmount, nextUnit),
    });
  };

  return (
    <div className="flex flex-col gap-1">
      {dailyOnly ? (
        <span className="text-xs text-text-3">Once a day</span>
      ) : (
        <div className="flex items-start gap-1">
          <span className="mt-1 text-xs text-text-3">Every</span>
          <RecurrenceAmountInput
            ariaLabel={`Change interval amount for ${label}`}
            amount={amount}
            disabled={disabled}
            onCommit={(nextAmount) => updateInterval(nextAmount, unit)}
            className="w-14 rounded-[8px] border border-border bg-surface-2 px-2 py-1 text-xs text-text disabled:opacity-50"
          />
          <select
            aria-label={`Change interval unit for ${label}`}
            value={unit}
            disabled={disabled}
            onChange={(e) =>
              updateInterval(amount, e.target.value as RecurrenceUnit)
            }
            className="rounded-[8px] border border-border bg-surface-2 px-2 py-1 text-xs text-text disabled:opacity-50"
          >
            {RECURRENCE_UNIT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <input
        type="time"
        aria-label={`Change starting time for ${label}`}
        value={anchorToLocalTimeInputValue(recurrence.anchorMinuteUtc)}
        disabled={disabled}
        onChange={(e) =>
          onChange({
            ...recurrence,
            anchorMinuteUtc: localTimeInputValueToAnchor(e.target.value),
          })
        }
        className="rounded-[8px] border border-border bg-surface-2 px-2 py-1 text-xs text-text disabled:opacity-50"
      />
      <span className="text-[11px] text-text-3">
        {formatRecurrence(recurrence)}
      </span>
    </div>
  );
}

function runStatusFor(schedule: ScheduledTrigger, runId: string): string {
  return (
    schedule.recentFires.find((f) => f.runId === runId)?.status ?? "running"
  );
}

function ScheduleRow({
  schedule,
  label,
}: {
  schedule: ScheduledTrigger;
  label: string;
}) {
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();

  const handleToggle = () => {
    updateSchedule
      .mutateAsync({ id: schedule.id, enabled: !schedule.enabled })
      .catch(() => {
        /* optimistic update rolled back in the hook */
      });
  };

  const handleDelete = () => {
    deleteSchedule.mutateAsync({ id: schedule.id }).catch(() => {
      /* optimistic removal rolled back in the hook */
    });
  };

  const handleRecurrenceChange = (
    recurrence: ScheduledTrigger["recurrence"],
  ) => {
    updateSchedule.mutateAsync({ id: schedule.id, recurrence }).catch(() => {
      /* optimistic update rolled back in the hook */
    });
  };

  const reduceMotion = useReducedMotion();

  return (
    <motion.li
      layout
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={
        reduceMotion
          ? undefined
          : { opacity: 0, height: 0, marginTop: 0, overflow: "hidden" }
      }
      transition={
        reduceMotion
          ? { duration: 0 }
          : { type: "spring", stiffness: 380, damping: 34 }
      }
      className="flex items-center gap-3 border-b border-border/60 px-4 py-3 last:border-b-0"
    >
      <EnabledToggle
        enabled={schedule.enabled}
        disabled={updateSchedule.isPending}
        label={label}
        onToggle={handleToggle}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-semibold text-text">
          {label}
          <span className="ml-1.5 font-normal text-text-3">
            · {scheduleScopeLabel(schedule.scope)}
          </span>
        </span>
        <span className="text-xs text-text-3">
          Last fired:{" "}
          {schedule.lastRunId ? (
            <Link
              to={scheduleRunDeepLink(
                runStatusFor(schedule, schedule.lastRunId),
                schedule.lastRunId,
              )}
              className="font-medium text-text-2 underline-offset-2 hover:underline"
            >
              {formatLastFiredAt(schedule.recentFires[0]?.firedAt ?? null)}
            </Link>
          ) : (
            formatLastFiredAt(schedule.recentFires[0]?.firedAt ?? null)
          )}{" "}
          · Next: {formatNextFire(schedule.nextFireAt, schedule.enabled)}
        </span>
        {schedule.recentFires.length > 0 && (
          <ul className="mt-1 flex flex-col gap-0.5 text-[11px] text-text-3">
            {schedule.recentFires.map((fire) => (
              <li key={`${fire.runId}-${fire.firedAt}`}>
                <Link
                  to={scheduleRunDeepLink(fire.status, fire.runId)}
                  className="text-text-2 underline-offset-2 hover:underline"
                >
                  {new Date(fire.firedAt).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </Link>
                <span className="text-text-3"> · {fire.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <RecurrenceSelect
        recurrence={schedule.recurrence}
        disabled={updateSchedule.isPending}
        label={label}
        onChange={handleRecurrenceChange}
      />
      <ConfirmButton
        variant="ghost"
        size="sm"
        confirmLabel="Confirm remove"
        disabled={deleteSchedule.isPending}
        onConfirm={handleDelete}
      >
        Remove
      </ConfirmButton>
    </motion.li>
  );
}

// The member's routine schedules: one row per scheduled workflow with an
// enable/pause switch and a confirm-guarded remove. Workflow labels are resolved
// against the same catalog the schedules were created from.
export function MySchedules({ tenantId, embedded = false }: MySchedulesProps) {
  const { data: schedules, isPending, isError } = useMeSchedules();
  const catalog = useWorkflowsCatalog(tenantId);

  const labelForKind = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of catalog.data?.entries ?? []) {
      map.set(entry.kind, entry.label);
    }
    return (kind: string) => map.get(kind) ?? kind;
  }, [catalog.data]);

  return (
    <section
      className={embedded ? "flex flex-col gap-4" : "mt-10 flex flex-col gap-4"}
    >
      {!embedded && (
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold tracking-[-0.01em] text-text">
            My schedules
          </h2>
          <p className="text-[12px] text-text-3">
            Daily routines you own.{" "}
            <span className="text-text-2">Everyone</span> schedules run once for
            the workspace and fan outcomes into inboxes — not once per person.
          </p>
        </div>
      )}

      {isPending && (
        <p className="py-4 text-[13px] text-text-3">Loading your schedules…</p>
      )}
      {isError && (
        <p className="py-4 text-[13px] text-text-2">
          Couldn&rsquo;t load your schedules. Refresh to try again.
        </p>
      )}
      {!isPending && !isError && schedules && schedules.length === 0 && (
        <div className="rounded-[14px] border border-dashed border-border bg-surface/60 px-6 py-10 text-center">
          <p className="text-sm font-semibold text-text">No schedules yet</p>
          <p className="mt-1 text-xs text-text-3">
            Schedule a workflow from the catalog above.
          </p>
        </div>
      )}
      {!isPending && !isError && schedules && schedules.length > 0 && (
        <ul className="overflow-hidden rounded-[14px] border border-border bg-surface">
          <AnimatePresence initial={false}>
            {schedules.map((schedule) => (
              <ScheduleRow
                key={schedule.id}
                schedule={schedule}
                label={labelForKind(schedule.workflowKind)}
              />
            ))}
          </AnimatePresence>
        </ul>
      )}
    </section>
  );
}
