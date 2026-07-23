import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button } from "@workbench/ui";
import type { ScheduledTrigger, ScheduleRecurrence } from "@workbench/shared";
import { getOwnerSchedules, updateOwnerSchedule } from "../../lib/hub-api";
import {
  decodeRecurrenceKey,
  encodeRecurrence,
  formatLastFiredAt,
  formatNextFire,
  recurrenceOptions,
} from "../../lib/schedule-time";
import { adminTableCard } from "./admin-ui";

/**
 * Owner → Schedules (CL-4113). Control-plane list of **Everyone**
 * (tenant-scoped) schedules for the root workbench tenant — kind, cadence,
 * last/next fire, pause. Personal schedules stay under member Routines.
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
        Workspace routines scheduled for{" "}
        <span className="font-medium text-text">Everyone</span> — one run per
        fire for the whole workbench, not once per member. Personal schedules
        live under each member&rsquo;s Routines list.
      </p>
      {error && (
        <p className="text-sm text-red-500" role="status">
          {error}
        </p>
      )}
      {items.length === 0 ? (
        <p className="p-3 text-sm text-text-2">
          No Everyone schedules yet. Members create them from the workflow
          catalog with scope &ldquo;Everyone.&rdquo;
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
  const options = useMemo(() => recurrenceOptions(), []);
  const kind = schedule.workflowKind;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 p-3">
      <div className="min-w-0">
        <p className="font-mono text-sm font-medium text-text">{kind}</p>
        <p className="mt-1 text-xs text-text-3">
          Last: {formatLastFiredAt(schedule.recentFires[0]?.firedAt ?? null)} ·
          Next: {formatNextFire(schedule.nextFireAt, schedule.enabled)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={`Change cadence for ${kind}`}
          value={encodeRecurrence(schedule.recurrence)}
          disabled={busy}
          onChange={(e) =>
            onRecurrenceChange(decodeRecurrenceKey(e.target.value))
          }
          className="rounded-[8px] border border-border bg-surface-2 px-2 py-1 text-xs text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong disabled:opacity-50"
        >
          {options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
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
