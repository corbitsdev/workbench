import { useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Button } from "@workbench/ui";
import {
  useCreateSchedule,
  useMeSchedules,
  useUpdateSchedule,
} from "../hooks/use-schedules";
import {
  formatUtcHourLocal,
  localHourToUtc,
  utcHourOptions,
} from "../lib/schedule-time";

export interface SchedulePopoverProps {
  kind: string;
  label: string;
}

function ClockIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M12 7v5l3.2 2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function HourPicker({
  value,
  onChange,
  id,
}: {
  value: number;
  onChange: (hourUtc: number) => void;
  id: string;
}) {
  const options = useMemo(() => utcHourOptions(), []);
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full rounded-[8px] border border-border bg-surface-2 px-3 py-2 text-[13px] text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
    >
      {options.map((o) => (
        <option key={o.hourUtc} value={o.hourUtc}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// The schedule affordance for a single catalog workflow: opens a popover that
// either creates a daily schedule (local-time hour picker, stored as UTC) or,
// when one already exists for this workflow, surfaces its state with inline
// pause/resume and an hour edit.
export function SchedulePopover({ kind, label }: SchedulePopoverProps) {
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [draftHourUtc, setDraftHourUtc] = useState(() => localHourToUtc(8));
  const [error, setError] = useState<string | null>(null);

  const { data: schedules } = useMeSchedules();
  const existing = schedules?.find((s) => s.workflowKind === kind) ?? null;

  const createSchedule = useCreateSchedule();
  const updateSchedule = useUpdateSchedule();

  const handleCreate = () => {
    setError(null);
    createSchedule
      .mutateAsync({ kind, hourUtc: draftHourUtc })
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : "Could not save the schedule.",
        );
      });
  };

  const handleToggle = () => {
    if (!existing) return;
    setError(null);
    updateSchedule
      .mutateAsync({ id: existing.id, enabled: !existing.enabled })
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : "Could not update the schedule.",
        );
      });
  };

  const handleHourChange = (hourUtc: number) => {
    if (existing) {
      setError(null);
      updateSchedule
        .mutateAsync({ id: existing.id, hourUtc })
        .catch((err: unknown) => {
          setError(
            err instanceof Error
              ? err.message
              : "Could not update the schedule.",
          );
        });
      return;
    }
    setDraftHourUtc(hourUtc);
  };

  const triggerLabel =
    existing && existing.enabled
      ? `Scheduled · ${formatUtcHourLocal(existing.hourUtc)}`
      : existing
        ? "Schedule paused"
        : "Schedule";

  return (
    <div className="relative">
      <button
        type="button"
        data-tour="workflow-schedule"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded-[10px] border px-3.5 py-2 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong ${
          existing && existing.enabled
            ? "border-orange text-orange"
            : "border-border text-text-2 hover:bg-surface-2"
        }`}
      >
        <ClockIcon />
        {triggerLabel}
      </button>

      <AnimatePresence>
        {open && (
          <>
            <button
              type="button"
              aria-label="Close schedule"
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-10 cursor-default"
              tabIndex={-1}
            />
            <motion.div
              role="dialog"
              aria-label={`Schedule ${label}`}
              initial={
                reduceMotion ? false : { opacity: 0, y: -6, scale: 0.98 }
              }
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={
                reduceMotion ? undefined : { opacity: 0, y: -6, scale: 0.98 }
              }
              transition={{ type: "spring", stiffness: 420, damping: 30 }}
              className="absolute right-0 z-20 mt-2 w-[280px] rounded-[14px] border border-border bg-surface p-4 shadow-[var(--shadow)]"
            >
              <p className="mb-1 text-sm font-semibold text-text">
                Daily schedule
              </p>
              <p className="mb-3 text-xs leading-relaxed text-text-3">
                {existing
                  ? "Runs every day at the time below, in your local time."
                  : `Run "${label}" every day at a time you pick.`}
              </p>

              <label
                htmlFor={`sched-hour-${kind}`}
                className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.05em] text-text-3"
              >
                Time (your local time)
              </label>
              <HourPicker
                id={`sched-hour-${kind}`}
                value={existing ? existing.hourUtc : draftHourUtc}
                onChange={handleHourChange}
              />

              {error && <p className="mt-2 text-xs text-red">{error}</p>}

              <div className="mt-4 flex items-center justify-between gap-2">
                {existing ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={updateSchedule.isPending}
                    onClick={handleToggle}
                  >
                    {existing.enabled ? "Pause" : "Resume"}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    disabled={createSchedule.isPending}
                    onClick={handleCreate}
                  >
                    {createSchedule.isPending ? "Saving…" : "Schedule"}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setOpen(false)}
                >
                  Done
                </Button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
