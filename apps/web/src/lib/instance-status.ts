/**
 * Wire agent-instance status → member-facing label. Error-ish and unknown
 * statuses return undefined so callers omit the row entirely — failures are
 * never surfaced in member-facing UI.
 */
export function humanizeInstanceStatus(status: string): string | undefined {
  switch (status.trim().toLowerCase()) {
    case "running":
      return "Active";
    case "stopped":
    case "ended":
      return "Asleep";
    case "provisioning":
      return "Starting";
    default:
      return undefined;
  }
}
