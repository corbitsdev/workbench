import { FileText, GitBranch, MessagesSquare, X } from "lucide-react";
import type { ActiveContextKind, ActiveContextRef } from "@workbench/shared";

// `MessagesSquare` (stacked) for a thread, distinct from the single
// `MessageSquare` the app already uses for the send-to-chat action.
const KIND_ICON: Record<
  ActiveContextKind,
  React.ComponentType<{ size?: number; className?: string }>
> = {
  artifact: FileText,
  "workflow-run": GitBranch,
  thread: MessagesSquare,
};

const KIND_LABEL: Record<ActiveContextKind, string> = {
  artifact: "Artifact",
  "workflow-run": "Workflow run",
  thread: "Thread",
};

/**
 * Removable chips for the surfaces attached to the next Myra message
 * (CL-2495). Each shows the surface kind and its label; the close button
 * detaches it.
 */
export function ActiveContextPills({
  attached,
  onRemove,
}: {
  attached: ActiveContextRef[];
  onRemove: (ref: ActiveContextRef) => void;
}) {
  if (attached.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {attached.map((ref) => {
        const Icon = KIND_ICON[ref.kind];
        const label = ref.label.trim() || "Untitled";
        return (
          <span
            key={`${ref.kind}:${ref.id}`}
            className="flex items-center gap-1.5 rounded border border-border bg-surface-2 py-1 pl-2 pr-1 text-[12px] text-text-2"
          >
            <Icon size={12} className="shrink-0 text-text-3" aria-hidden />
            <span className="max-w-[180px] truncate" title={label}>
              <span className="text-text-3">{KIND_LABEL[ref.kind]}:</span>{" "}
              <span className="text-text">{label}</span>
            </span>
            <button
              type="button"
              onClick={() => onRemove(ref)}
              aria-label={`Remove ${KIND_LABEL[ref.kind]} ${label}`}
              className="relative grid h-5 w-5 shrink-0 place-items-center rounded text-text-3 transition-colors after:absolute after:-inset-2 after:content-[''] hover:bg-row-hover hover:text-text active:scale-90"
            >
              <X size={11} aria-hidden />
            </button>
          </span>
        );
      })}
    </div>
  );
}
