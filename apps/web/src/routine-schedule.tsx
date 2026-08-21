// The routine panel's inline schedule editor (CL-6139): replaces the old
// multi-click "On a schedule" → cadence menu → sub-menu chain
// (`routines-page.tsx`'s now-removed `TriggerPicker`) with one surface —
// five one-click presets plus a custom row, both committing on the same
// blur/select interactions the panel's Name/Instruction fields already
// use. Every cadence this renders goes through `@corbits/routines/trigger`'s
// own cron builders (`cronTriggerForWeekdays`, `cronExpressionForTrigger`
// via `routineCadenceLabel`'s live summary) — this module hand-rolls no
// cron of its own.

import { useState } from "react";
import {
  Button,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from "@corbits/react-ui";
import {
  cronTriggerForWeekdays,
  routineScheduleSentence,
  ROUTINE_WEEKDAY_NAMES,
  type RoutineTriggerT,
} from "@corbits/routines/client";

type ScheduleTrigger = Exclude<RoutineTriggerT, null | { kind: "webhook" }>;

export type SchedulePreset = {
  readonly id: string;
  readonly label: string;
  readonly trigger: () => ScheduleTrigger;
};

const WEEKDAY_SHORT_NAMES = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

/** The five cadences a person reaches for most often — each one commits
 * the whole schedule in a single click, no follow-up menu. */
export const SCHEDULE_PRESETS: readonly SchedulePreset[] = [
  {
    id: "every-15-min",
    label: "Every 15 min",
    trigger: () => ({ kind: "interval", unit: "minutes", every: 15 }),
  },
  {
    id: "hourly",
    label: "Hourly",
    trigger: () => ({ kind: "interval", unit: "hours", every: 1 }),
  },
  {
    id: "daily-9",
    label: "Daily 9:00",
    trigger: () => ({ kind: "daily", hour: 9, minute: 0 }),
  },
  {
    id: "weekdays-9",
    label: "Weekdays 9:00",
    trigger: () => cronTriggerForWeekdays([1, 2, 3, 4, 5], 9, 0),
  },
  {
    id: "weekly-mon-9",
    label: "Weekly Mon 9:00",
    trigger: () => ({ kind: "weekly", dayOfWeek: 1, hour: 9, minute: 0 }),
  },
];

function triggerEquals(a: ScheduleTrigger, b: ScheduleTrigger): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Which preset (if any) `trigger` currently matches — drives the pressed
 * state on the preset row. `null` when it's a custom cadence. */
export function matchingPresetId(trigger: ScheduleTrigger): string | null {
  return (
    SCHEDULE_PRESETS.find((preset) => triggerEquals(preset.trigger(), trigger))
      ?.id ?? null
  );
}

/** Custom "Every N minutes/hours/days" — the interval branch of the custom
 * row. `every` is clamped to a positive integer the same way the old
 * `TriggerPicker`'s number input was. */
export function customIntervalTrigger(
  every: number,
  unit: "minutes" | "hours" | "days",
): ScheduleTrigger {
  return {
    kind: "interval",
    unit,
    every: Math.max(1, Math.trunc(every) || 1),
  };
}

/** Custom "at HH:MM on one or more days" — a single day renders as the
 * `weekly` preset shape, more than one goes through
 * `cronTriggerForWeekdays` (the shape `weekly`'s single `dayOfWeek` can't
 * express). `null` for no day picked yet — nothing to commit. */
export function customAtTrigger(
  hour: number,
  minute: number,
  days: readonly number[],
): ScheduleTrigger | null {
  if (days.length === 0) return null;
  if (days.length === 1) {
    return { kind: "weekly", dayOfWeek: days[0] as number, hour, minute };
  }
  return cronTriggerForWeekdays(days, hour, minute);
}

type CustomMode = "interval" | "at";

function initialCustomMode(trigger: ScheduleTrigger | null): CustomMode {
  return trigger !== null && trigger.kind === "interval" ? "interval" : "at";
}

function initialEvery(trigger: ScheduleTrigger | null): number {
  return trigger !== null && trigger.kind === "interval" ? trigger.every : 15;
}

function initialUnit(
  trigger: ScheduleTrigger | null,
): "minutes" | "hours" | "days" {
  return trigger !== null && trigger.kind === "interval"
    ? trigger.unit
    : "minutes";
}

function initialHour(trigger: ScheduleTrigger | null): number {
  if (
    trigger !== null &&
    (trigger.kind === "daily" || trigger.kind === "weekly")
  ) {
    return trigger.hour;
  }
  return 9;
}

function initialMinute(trigger: ScheduleTrigger | null): number {
  if (
    trigger !== null &&
    (trigger.kind === "daily" || trigger.kind === "weekly")
  ) {
    return trigger.minute;
  }
  return 0;
}

function initialDays(trigger: ScheduleTrigger | null): readonly number[] {
  if (trigger !== null && trigger.kind === "weekly") return [trigger.dayOfWeek];
  return [];
}

/**
 * The panel's "When to run" schedule surface: preset row, custom row, live
 * summary. Every interaction commits immediately (a preset click, a
 * number/time blur, a unit or day pick) — the same one-step contract the
 * panel's own Name/Instruction fields use, never a second "Save" step.
 */
export function ScheduleEditor({
  value,
  onChange,
  disabled = false,
}: {
  readonly value: ScheduleTrigger | null;
  readonly onChange: (next: ScheduleTrigger) => void;
  readonly disabled?: boolean;
}) {
  const [customMode, setCustomMode] = useState<CustomMode>(
    initialCustomMode(value),
  );
  const [every, setEvery] = useState(initialEvery(value));
  const [unit, setUnit] = useState<"minutes" | "hours" | "days">(
    initialUnit(value),
  );
  const [hour, setHour] = useState(initialHour(value));
  const [minute, setMinute] = useState(initialMinute(value));
  const [days, setDays] = useState<readonly number[]>(initialDays(value));

  const selectedPreset = value === null ? null : matchingPresetId(value);

  function toggleDay(day: number) {
    const nextDays = days.includes(day)
      ? days.filter((d) => d !== day)
      : [...days, day];
    setDays(nextDays);
    const next = customAtTrigger(hour, minute, nextDays);
    if (next !== null) onChange(next);
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex flex-wrap gap-1.5"
        role="group"
        aria-label="Schedule presets"
      >
        {SCHEDULE_PRESETS.map((preset) => (
          <Button
            key={preset.id}
            type="button"
            variant={selectedPreset === preset.id ? "primary" : "outline"}
            size="sm"
            disabled={disabled}
            aria-pressed={selectedPreset === preset.id}
            onClick={() => onChange(preset.trigger())}
          >
            {preset.label}
          </Button>
        ))}
      </div>

      <div className="flex flex-col gap-1.5 rounded-[var(--ui-radius-md)] border border-[var(--ui-border)] p-2">
        <span className="text-xs font-medium text-[var(--ui-fg-muted)]">
          Custom
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <Menu>
            <MenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
              >
                {customMode === "interval" ? "Every…" : "At a time…"}
              </Button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem onSelect={() => setCustomMode("interval")}>
                Every…
              </MenuItem>
              <MenuItem onSelect={() => setCustomMode("at")}>
                At a time…
              </MenuItem>
            </MenuContent>
          </Menu>

          {customMode === "interval" ? (
            <>
              <Input
                type="number"
                min={1}
                value={every}
                disabled={disabled}
                aria-label="Every"
                onChange={(event) =>
                  setEvery(
                    Math.max(1, Math.trunc(event.target.valueAsNumber) || 1),
                  )
                }
                onBlur={() => onChange(customIntervalTrigger(every, unit))}
              />
              <Menu>
                <MenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                  >
                    {unit}
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  {(["minutes", "hours", "days"] as const).map((option) => (
                    <MenuItem
                      key={option}
                      onSelect={() => {
                        setUnit(option);
                        onChange(customIntervalTrigger(every, option));
                      }}
                    >
                      {option}
                    </MenuItem>
                  ))}
                </MenuContent>
              </Menu>
            </>
          ) : (
            <>
              <Input
                type="time"
                value={`${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`}
                disabled={disabled}
                aria-label="At"
                onChange={(event) => {
                  const [nextHour, nextMinute] = event.target.value
                    .split(":")
                    .map(Number);
                  setHour(nextHour ?? 0);
                  setMinute(nextMinute ?? 0);
                }}
                onBlur={() => {
                  const next = customAtTrigger(hour, minute, days);
                  if (next !== null) onChange(next);
                }}
              />
              <span className="text-xs text-[var(--ui-fg-muted)]">UTC</span>
            </>
          )}
        </div>

        {customMode === "at" ? (
          <div
            className="flex flex-wrap gap-1"
            role="group"
            aria-label="Days of the week"
          >
            {ROUTINE_WEEKDAY_NAMES.map((name, index) => (
              <Button
                key={name}
                type="button"
                variant={days.includes(index) ? "primary" : "outline"}
                size="sm"
                disabled={disabled}
                aria-pressed={days.includes(index)}
                aria-label={name}
                onClick={() => toggleDay(index)}
              >
                {WEEKDAY_SHORT_NAMES[index]}
              </Button>
            ))}
          </div>
        ) : null}
      </div>

      {value !== null ? (
        <p className="text-xs text-[var(--ui-fg-muted)]" role="status">
          {routineScheduleSentence(value)}
        </p>
      ) : null}
    </div>
  );
}
