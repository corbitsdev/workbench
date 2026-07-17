import { AlertTriangle } from "lucide-react";
import type { TimelineEntry } from "@workbench/client";

// A grant/credential row in any activity view is a current-state read, not a
// history: past changes, revocations, and who made them are never recorded.
// This single banner is the canonical disclosure — shown identically across
// every timeline surface (tenant activity feed, actor timeline, moment walker)
// so the caveat cannot drift in wording or be mistaken for an audit record.

export function hasPermissionEntry(entries: TimelineEntry[]): boolean {
  return entries.some((e) => e.kind === "grant" || e.kind === "credential");
}

export function PermissionCaveatBanner({
  entries,
}: {
  entries: TimelineEntry[];
}) {
  if (!hasPermissionEntry(entries)) return null;
  return (
    <p
      className="flex items-start gap-1.5 rounded-[12px] border border-border bg-surface px-3 py-2 text-[12px] leading-snug text-text-2"
      data-testid="permission-caveat"
    >
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-gold" />
      <span>
        Grant and credential entries reflect their current state only — past
        changes, revocations, and who made them are not recorded, so this is not
        an audit history for permissions or credentials.
      </span>
    </p>
  );
}
