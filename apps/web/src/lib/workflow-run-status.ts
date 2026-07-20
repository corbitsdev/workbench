import { toHumanLabel } from "@workbench/ui";
import type { RunSort, RunStatusFilter } from "./workflow-run-filters";

// Shared run-status vocabulary used by the Insights run-history view. Kept out
// of any page component so both the filter controls and the row rendering read
// from one source.
export const STATUS_FILTER_OPTIONS: {
  value: RunStatusFilter;
  label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "provisioning", label: "Starting" },
  { value: "running", label: "Running" },
  { value: "awaiting", label: "Awaiting" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  // User-stopped (CL-3689) — distinct from Failed; stays in history until Archive.
  { value: "stopped", label: "Stopped" },
];

export const SORT_OPTIONS: { value: RunSort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

export function formatRunWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function statusLabel(status: string): string {
  const match = STATUS_FILTER_OPTIONS.find((opt) => opt.value === status);
  return match ? match.label : toHumanLabel(status);
}

export function statusTextClass(status: string): string {
  if (status === "completed") return "text-green";
  if (status === "failed") return "text-red-500";
  // Neutral (not error red) so a user-stopped / cancelled run does not read as a failure.
  if (status === "stopped" || status === "cancelled") return "text-text-3";
  return "text-blue";
}

export function statusDotClass(status: string): string {
  if (status === "completed") return "bg-green";
  if (status === "failed") return "bg-red-500";
  if (status === "stopped" || status === "cancelled") return "bg-text-3";
  return "bg-blue";
}

