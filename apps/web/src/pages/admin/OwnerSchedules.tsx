import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@workbench/ui";
import type { ScheduledTrigger, ScheduleRecurrence } from "@workbench/shared";
import { getOwnerSchedules, updateOwnerSchedule } from "../../lib/hub-api";
import { RecurrenceAmountInput } from "../../components/RecurrenceAmountInput";
import {
  amountUnitFromInterval,
  anchorToLocalTimeInputValue,
  formatLastFiredAt,
  formatNextFire,
  formatRecurrence,
  intervalFromAmountUnit,
  localTimeInputValueToAnchor,
  onlyDailyAllowedForKind,
  type RecurrenceUnit,
} from "../../lib/schedule-time";
import { adminTableCard } from "./admin-ui";

const RECURRENCE_UNIT_OPTIONS: { value: RecurrenceUnit; label: string }[] = [
  { value: "minutes", label: "minutes" },
  { value: "hours", label: "hours" },
  { value: "days", label: "days" },
  { value: "weeks", label: "weeks" },
];

/**
 * Owner → Schedules. Control-plane list of **Everyone**
 * (tenant-scoped) schedules for the root workbench tenant — kind, cadence,
 * last/next fire, pause. Personal schedules stay under member Workflows.
 *
 * Labels use `workflowKind` (owner workflow catalog has no display names).
 */
export function OwnerSchedules() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const schedules = useQuery({
    queryKey: ["owner", "schedules"],
    queryFn: getOwnerSchedules,
    staleTime: 60_000,
  });

  const patch = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: { enabled?: boolean; recurrence?: ScheduleRecurrence };
    }) => updateOwnerSchedule(id, body),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["owner", "schedules"] });
    },
    onError: () =>
      setError("Could not update the schedule. Try again in a moment."),
  });

  if (schedules.isLoading) {
    return <p className="p-3 text-sm text-text-2">Loading…</p>;
  }
  if (schedules.isError || !schedules.data) {
    return (
      <p className="p-3 text-sm text-text-2">
        Could not load workspace schedules. Try again in a moment.
      </p>
    );
  }

  const items = schedules.data;

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-2">
        Workspace workflows scheduled for{" "}
        <span className="font-medium text-text">Everyone</span> — one run per
        fire for the whole workbench, not once per member. Personal schedules
        live under each member&rsquo;s Workflows list.
      </p>
      {error && (
        <p className="text-sm text-red-500" role="status">
          {error}
        </p>
      )}
      {items.length === 0 ? (
        <p className="p-3 text-sm text-text-2">
          No Everyone schedules yet. Members create them from Workflows with
          scope &ldquo;Everyone.&rdquo;
        </p>
      ) : (
        <div className={adminTableCard}>
          <ul className="divide-y divide-border">
            {items.map((s) => (
              <ScheduleRow
                key={s.id}
                schedule={s}
                busy={patch.isPending && patch.variables?.id === s.id}
                onToggle={() =>
                  patch.mutate({
                    id: s.id,
                    body: { enabled: !s.enabled },
                  })
                }
                onRecurrenceChange={(recurrence) =>
                  patch.mutate({ id: s.id, body: { recurrence } })
                }
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ScheduleRow({
  schedule,
  busy,
  onToggle,
  onRecurrenceChange,
}: {
  schedule: ScheduledTrigger;
  busy: boolean;
  onToggle: () => void;
  onRecurrenceChange: (recurrence: ScheduleRecurrence) => void;
}) {
  const kind = schedule.workflowKind;
  const dailyOnly = onlyDailyAllowedForKind(kind);
  const { amount, unit } = amountUnitFromInterval(
    schedule.recurrence.intervalMinutes,
  );

  const updateInterval = (nextAmount: number, nextUnit: RecurrenceUnit) => {
    onRecurrenceChange({
      ...schedule.recurrence,
      intervalMinutes: intervalFromAmountUnit(nextAmount, nextUnit),
    });
  };

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 p-3">
      <div className="min-w-0">
        <p className="font-mono text-sm font-medium text-text">{kind}</p>
        <p className="mt-1 text-xs text-text-3">
          Last: {formatLastFiredAt(schedule.recentFires[0]?.firedAt ?? null)} ·
          Next: {formatNextFire(schedule.nextFireAt, schedule.enabled)}
        </p>
        <p className="mt-1 text-xs text-text-3">
          {formatRecurrence(schedule.recurrence)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {dailyOnly ? (
          <span className="text-xs text-text-3">Once a day</span>
        ) : (
          <>
            <span className="text-xs text-text-3">Every</span>
            <RecurrenceAmountInput
              ariaLabel={`Change interval amount for ${kind}`}
              amount={amount}
              disabled={busy}
              onCommit={(nextAmount) => updateInterval(nextAmount, unit)}
              className="w-14 rounded-[8px] border border-border bg-surface-2 px-2 py-1 text-xs text-text disabled:opacity-50"
            />
            <select
              aria-label={`Change interval unit for ${kind}`}
              value={unit}
              disabled={busy}
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
          </>
        )}
        <input
          type="time"
          aria-label={`Change starting time for ${kind}`}
          value={anchorToLocalTimeInputValue(
            schedule.recurrence.anchorMinuteUtc,
          )}
          disabled={busy}
          onChange={(e) =>
            onRecurrenceChange({
              ...schedule.recurrence,
              anchorMinuteUtc: localTimeInputValueToAnchor(e.target.value),
            })
          }
          className="rounded-[8px] border border-border bg-surface-2 px-2 py-1 text-xs text-text disabled:opacity-50"
        />
        <Button
          type="button"
          variant={schedule.enabled ? "ghost" : "primary"}
          size="sm"
          disabled={busy}
          onClick={onToggle}
        >
          {schedule.enabled ? "Pause" : "Resume"}
        </Button>
      </div>
    </li>
  );
}
