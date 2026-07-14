import { INTAKE_SIGNAL_NAME } from "../lib/scheduled-intake";

export const SCHEDULED_GATE_TEMPLATE_KEY = "myra-scheduled-gate";

/** Pure: whether a scheduler-sourced run should get Myra gate-drive for open gates. */
export function postIntakeGatesForScheduledDrive(
  triggerSource: string | null | undefined,
  pendingGates: readonly { signalName: string }[],
): string[] {
  if (triggerSource !== "scheduler") return [];
  return pendingGates
    .map((g) => g.signalName)
    .filter((name) => name !== INTAKE_SIGNAL_NAME)
    .sort();
}