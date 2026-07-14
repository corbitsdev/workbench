import { cn } from "@workbench/ui";
import { type QuickReply } from "./types";

export interface QuickReplyChipsProps {
  replies: QuickReply[];
  /** Called with the chosen reply's `value` if set, otherwise its `label`. */
  onSelect: (reply: QuickReply) => void;
  className?: string;
}

/** A horizontal set of tappable suggested-reply chips. */
export function QuickReplyChips({
  replies,
  onSelect,
  className,
}: QuickReplyChipsProps) {
  if (replies.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {replies.map((reply) => (
        <button
          key={reply.id}
          type="button"
          onClick={() => onSelect(reply)}
          className="rounded-input border border-border bg-page px-3 py-1.5 text-xs text-text-2 transition-colors hover:bg-row-hover hover:text-text cursor-pointer"
        >
          {reply.label}
        </button>
      ))}
    </div>
  );
}
