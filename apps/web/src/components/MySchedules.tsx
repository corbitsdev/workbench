import { useMemo } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { ScheduledTrigger } from "@workbench/shared";
import { ConfirmButton } from "@workbench/ui";
import {
  useDeleteSchedule,
  useMeSchedules,
  useUpdateSchedule,
} from "../hooks/use-schedules";
import { useWorkflowsCatalog } from "../hooks/use-workflows-catalog";
import { formatUtcHourLocal } from "../lib/schedule-time";

export interface MySchedulesProps {
  tenantId: string | null;
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
        enabled ? "bg-accent" : "bg-border-strong"
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

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, marginTop: 0, overflow: "hidden" }}
      transition={{ type: "spring", stiffness: 380, damping: 34 }}
      className="flex items-center gap-3 border-b border-border/60 px-4 py-3 last:border-b-0"
    >
      <EnabledToggle
        enabled={schedule.enabled}
        disabled={updateSchedule.isPending}
        label={label}
        onToggle={handleToggle}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13.5px] font-semibold text-text">
          {label}
        </span>
        <span className="text-[11.5px] text-text-3">
          {schedule.enabled
            ? `Daily at ${formatUtcHourLocal(schedule.hourUtc)}`
            : `Paused · was daily at ${formatUtcHourLocal(schedule.hourUtc)}`}
        </span>
      </div>
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

// The member's automation schedules: one row per scheduled workflow with an
// enable/pause switch and a confirm-guarded remove. Workflow labels are resolved
// against the same catalog the schedules were created from.
export function MySchedules({ tenantId }: MySchedulesProps) {
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
    <section className="mt-10 flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-[15px] font-bold tracking-[-0.01em] text-text">
          My schedules
        </h2>
        <p className="text-[12px] text-text-3">
          Workflows you&rsquo;ve put on a daily cadence.
        </p>
      </div>

      {isPending && (
        <p className="py-4 text-[13px] text-text-3">Loading your schedules…</p>
      )}
      {isError && (
        <p className="py-4 text-[13px] text-text-2">
          Couldn&rsquo;t load your schedules. Refresh to try again.
        </p>
      )}
      {!isPending && !isError && schedules && schedules.length === 0 && (
        <div className="rounded-[16px] border border-dashed border-border bg-surface/60 px-6 py-10 text-center">
          <p className="text-[14px] font-semibold text-text">
            Nothing scheduled yet
          </p>
          <p className="mt-1 text-[12.5px] text-text-3">
            Put a workflow on autopilot from the catalog above.
          </p>
        </div>
      )}
      {!isPending && !isError && schedules && schedules.length > 0 && (
        <ul className="overflow-hidden rounded-[16px] border border-border bg-surface">
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
