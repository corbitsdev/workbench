import { cn } from "@workbench/ui";
import { TASK_ADAPTER_CATALOG, type TaskExternalRef } from "@workbench/shared";

function adapterLabel(adapterId: string): string {
  return (
    TASK_ADAPTER_CATALOG.find((entry) => entry.id === adapterId)?.label ??
    adapterId
  );
}

// A task's downstream sync state, collapsed to the two states a member is ever
// allowed to see: "linked" (synced) or "sending" (pending — including a stuck
// or errored push, which the push service already reports as `pending`; house
// rule bars any failure/error state from member-facing UI). A `detached` ref
// means the member explicitly unlinked it, so it renders nothing.
export function TaskExternalRefChip({
  externalRef,
}: {
  externalRef: TaskExternalRef;
}) {
  if (externalRef.syncState === "detached") return null;

  const label = adapterLabel(externalRef.adapterId);

  if (externalRef.syncState === "synced") {
    const chip = (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] font-medium text-text-2",
        )}
      >
        {label}
      </span>
    );
    if (!externalRef.externalUrl) return chip;
    return (
      <a
        href={externalRef.externalUrl}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => event.stopPropagation()}
        className={cn(
          "inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] font-medium text-text-2 transition-colors hover:border-border-strong hover:text-text",
        )}
      >
        {label}
      </a>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-page px-2 py-0.5 text-[11px] font-medium text-text-3">
      {label} · sending
    </span>
  );
}
