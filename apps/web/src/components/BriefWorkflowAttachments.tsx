import { useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Button, ConfirmButton } from "@workbench/ui";
import { Select } from "@workbench/settings";
import type { ScheduledTrigger } from "@workbench/shared";
import {
  useCreateSchedule,
  useDeleteSchedule,
  useMeSchedules,
} from "../hooks/use-schedules";
import { useWorkflowsCatalog } from "../hooks/use-workflows-catalog";
import { usePreferenceSettings } from "../hooks/use-preference-settings";
import { formatUtcHourLocal } from "../lib/schedule-time";

export interface BriefWorkflowAttachmentsProps {
  readonly tenantId: string | null;
}

const HEARTBEAT_KIND = "heartbeat";

function briefHourFromSettings(
  settings: readonly { key: string; value: boolean | string | number }[],
): number {
  const found = settings.find((s) => s.key === "briefHourUtc");
  return typeof found?.value === "number" ? found.value : 13;
}

function AttachedRow({
  schedule,
  label,
  onError,
}: {
  schedule: ScheduledTrigger;
  label: string;
  onError: (message: string) => void;
}) {
  const deleteSchedule = useDeleteSchedule();
  const reduceMotion = useReducedMotion();

  const handleDetach = () => {
    deleteSchedule.mutateAsync({ id: schedule.id }).catch(() => {
      onError("Could not detach the workflow. Try again.");
    });
  };

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
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-semibold text-text">
          {label}
        </span>
        <span className="text-xs text-text-3">
          Runs alongside your brief · {formatUtcHourLocal(schedule.hourUtc)}
        </span>
      </div>
      <ConfirmButton
        variant="ghost"
        size="sm"
        confirmLabel="Confirm detach"
        disabled={deleteSchedule.isPending}
        onConfirm={handleDetach}
      >
        Detach
      </ConfirmButton>
    </motion.li>
  );
}

/**
 * Lets a member attach catalog workflows to their brief window: attaching
 * creates a `scheduled_trigger` row for that workflow at the member's brief
 * hour (the same substrate `/me/schedules` and `SchedulePopover` already use —
 * no new execution rail). Attached workflows run alongside the brief; their
 * output lands as its own inbox item, never inlined into the brief mail.
 */
export function BriefWorkflowAttachments({
  tenantId,
}: BriefWorkflowAttachmentsProps) {
  const [selectedKind, setSelectedKind] = useState("");
  const [error, setError] = useState<string | null>(null);

  const schedules = useMeSchedules();
  const catalog = useWorkflowsCatalog(tenantId);
  const preferenceSettings = usePreferenceSettings();
  const createSchedule = useCreateSchedule();

  const attached = useMemo(
    () =>
      (schedules.data ?? []).filter((s) => s.workflowKind !== HEARTBEAT_KIND),
    [schedules.data],
  );

  const labelForKind = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of catalog.data?.entries ?? []) {
      map.set(entry.kind, entry.label);
    }
    return (kind: string) => map.get(kind) ?? kind;
  }, [catalog.data]);

  const attachedKinds = useMemo(
    () => new Set(attached.map((s) => s.workflowKind)),
    [attached],
  );

  const attachable = useMemo(
    () =>
      (catalog.data?.entries ?? []).filter(
        (entry) =>
          entry.attachable &&
          entry.kind !== HEARTBEAT_KIND &&
          !attachedKinds.has(entry.kind),
      ),
    [catalog.data, attachedKinds],
  );

  const [intakeValues, setIntakeValues] = useState<Record<string, string>>({});

  const selectedEntry = useMemo(
    () => attachable.find((entry) => entry.kind === selectedKind),
    [attachable, selectedKind],
  );
  const intakeFields = selectedEntry?.intakeFields ?? [];

  const missingRequiredIntake = intakeFields.some(
    (field) =>
      field.required === true && (intakeValues[field.name] ?? "").trim() === "",
  );

  const briefHourUtc = briefHourFromSettings(preferenceSettings.data ?? []);

  const handleSelectKind = (kind: string) => {
    setSelectedKind(kind);
    setIntakeValues({});
    setError(null);
  };

  const handleAttach = () => {
    if (selectedKind === "" || missingRequiredIntake) return;
    setError(null);
    // Only send fields the user actually filled; the server validates the intake
    // payload against the workflow's intake schema and stores it for auto-delivery.
    const payload = Object.fromEntries(
      intakeFields
        .map((field) => [field.name, (intakeValues[field.name] ?? "").trim()])
        .filter(([, value]) => value !== ""),
    );
    createSchedule
      .mutateAsync({
        kind: selectedKind,
        hourUtc: briefHourUtc,
        ...(Object.keys(payload).length > 0 ? { payload } : {}),
      })
      .then(() => {
        setSelectedKind("");
        setIntakeValues({});
      })
      .catch(() => {
        setError("Could not attach the workflow. Try again.");
      });
  };

  const isLoading =
    schedules.isPending || catalog.isPending || preferenceSettings.isPending;

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-text">Attached workflows</h3>
        <p className="text-xs text-text-3">
          Runs from the catalog you attach here fire alongside your brief. Their
          output lands in your inbox as its own item.
        </p>
      </div>

      {isLoading && (
        <p className="text-[13px] text-text-3">Loading workflows…</p>
      )}

      {!isLoading && attached.length === 0 && (
        <p className="text-[13px] text-text-3">
          No workflows attached to your brief yet.
        </p>
      )}

      {!isLoading && attached.length > 0 && (
        <ul className="overflow-hidden rounded-[14px] border border-border bg-surface">
          <AnimatePresence initial={false}>
            {attached.map((schedule) => (
              <AttachedRow
                key={schedule.id}
                schedule={schedule}
                label={labelForKind(schedule.workflowKind)}
                onError={setError}
              />
            ))}
          </AnimatePresence>
        </ul>
      )}

      {!isLoading && attachable.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Select
              aria-label="Choose a workflow to attach"
              value={selectedKind}
              onChange={(event) => handleSelectKind(event.target.value)}
            >
              <option value="">Choose a workflow…</option>
              {attachable.map((entry) => (
                <option key={entry.kind} value={entry.kind}>
                  {entry.label}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={
                selectedKind === "" ||
                missingRequiredIntake ||
                createSchedule.isPending
              }
              onClick={handleAttach}
            >
              {createSchedule.isPending ? "Attaching…" : "Attach"}
            </Button>
          </div>

          {intakeFields.length > 0 && (
            <div className="flex flex-col gap-2 rounded-[14px] border border-border bg-surface p-3">
              <p className="text-xs text-text-3">
                This workflow needs input up front. It runs unattended with what
                you provide here.
              </p>
              {intakeFields.map((field) => (
                <label key={field.name} className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-text">
                    {field.label}
                  </span>
                  {field.kind === "textarea" ? (
                    <textarea
                      className="min-h-[64px] rounded-lg border border-border bg-bg px-2 py-1 text-sm text-text"
                      placeholder={field.placeholder}
                      value={intakeValues[field.name] ?? ""}
                      onChange={(event) =>
                        setIntakeValues((prev) => ({
                          ...prev,
                          [field.name]: event.target.value,
                        }))
                      }
                    />
                  ) : (
                    <input
                      type="text"
                      className="rounded-lg border border-border bg-bg px-2 py-1 text-sm text-text"
                      placeholder={field.placeholder}
                      value={intakeValues[field.name] ?? ""}
                      onChange={(event) =>
                        setIntakeValues((prev) => ({
                          ...prev,
                          [field.name]: event.target.value,
                        }))
                      }
                    />
                  )}
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <p className="text-xs text-red">{error}</p>}
    </div>
  );
}
