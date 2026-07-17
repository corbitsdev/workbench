import { heartbeatIntakeStepKey, WIRED_BRIEF_SOURCES } from "@workbench/shared";
import type { DisplayStep } from "@workbench/ui";

export const HEARTBEAT_INTAKE_STEP_IDS = WIRED_BRIEF_SOURCES.map((source) =>
  heartbeatIntakeStepKey(source.key),
);

/** Runtime steps the run panel watches for failure (includes non-stepper plumbing). */
export const HEARTBEAT_FAILURE_WATCH_STEP_IDS = [
  ...HEARTBEAT_INTAKE_STEP_IDS,
  "merge-sources",
  "title",
  "brief",
  "mail-refs",
  "persist",
  "notify",
] as const;

export const DISPLAY_STEPS: DisplayStep[] = [
  { key: "intake", label: "Sources", stepIds: [...HEARTBEAT_INTAKE_STEP_IDS] },
  {
    key: "brief",
    label: "Brief",
    stepIds: ["brief"],
    activityLabel: "Writing your brief",
  },
  {
    key: "save",
    label: "Save",
    stepIds: ["persist"],
    activityLabel: "Saving to your workbench",
  },
  {
    key: "notify",
    label: "Deliver",
    stepIds: ["notify"],
    activityLabel: "Sending to your inbox",
  },
];