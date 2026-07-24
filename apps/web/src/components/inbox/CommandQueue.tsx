import { type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Archive, Inbox as InboxIcon, RotateCcw, Trash2 } from "lucide-react";
import { Button, cn } from "@workbench/ui";
import {
  focusQueueMeta,
  mailboxSenderLabel,
  type FocusPriority,
  type MailboxInboxView,
  type MailboxMessage,
} from "@workbench/shared";
import { formatRelativeTime } from "../../lib/relative-time";

export type CommandQueueKindFilter = "all" | "results" | "system";

interface CommandQueueProps {
  messages: MailboxMessage[];
  selectedId: string | null;
  selectedIds: Set<string>;
  isLoading: boolean;
  isError: boolean;
  reduceMotion: boolean;
  view: MailboxInboxView;
  kindFilter: CommandQueueKindFilter;
  onRetry: () => void;
  onOpen: (id: string) => void;
  onRowAction: (id: string, action: "archive" | "trash" | "restore") => void;
  onToggleSelect: (id: string) => void;
  onClearKindFilter: () => void;
}

// Hover-revealed controls also show on focus and on no-hover (touch) devices —
// a `:hover`-only reveal would make them unreachable there.
const rowRevealClass =
  "opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100";

// Queue band labels intentionally avoid "NOW" so they don't collide with the
// "Now" strip (top attention cards). Kind rank → urgency band only.
function priorityLabel(priority: FocusPriority): string {
  if (priority === "now") return "HIGH";
  if (priority === "next") return "MED";
  return "LOW";
}

/**
 * Dense Linear-style command queue for the hybrid inbox shell.
 * Columns: priority · subject · kind · from · when, with multi-select
 * and hover row archive/trash/restore.
 */
export function CommandQueue({
  messages,
  selectedId,
  selectedIds,
  isLoading,
  isError,
  reduceMotion,
  view,
  kindFilter,
  onRetry,
  onOpen,
  onRowAction,
  onToggleSelect,
  onClearKindFilter,
}: CommandQueueProps) {
  if (isLoading) {
    return (
      <p className="px-3 py-6 text-sm text-text-3" role="status">
        Loading messages…
      </p>
    );
  }

  if (isError) {
    return (
      <div className="px-3 py-6">
        <p className="text-sm text-text-2">Couldn't load your inbox.</p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-2 h-8 text-xs"
          onClick={onRetry}
        >
          Try again
        </Button>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <QueueEmptyState
        view={view}
        kindFilter={kindFilter}
        onClearKindFilter={onClearKindFilter}
      />
    );
  }

  return (
    <ul aria-label="Messages" className="flex flex-col gap-0.5">
      {messages.map((message, index) => (
        <motion.li
          key={message.id}
          initial={reduceMotion ? false : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            duration: 0.18,
            ease: "easeOut",
            delay: reduceMotion ? 0 : Math.min(index * 0.03, 0.24),
          }}
        >
          <QueueRow
            message={message}
            selected={message.id === selectedId}
            checked={selectedIds.has(message.id)}
            selectionActive={selectedIds.size > 0}
            reduceMotion={reduceMotion}
            view={view}
            onOpen={() => onOpen(message.id)}
            onRowAction={(action) => onRowAction(message.id, action)}
            onToggleSelect={() => onToggleSelect(message.id)}
          />
        </motion.li>
      ))}
    </ul>
  );
}

interface QueueRowProps {
  message: MailboxMessage;
  selected: boolean;
  checked: boolean;
  selectionActive: boolean;
  reduceMotion: boolean;
  view: MailboxInboxView;
  onOpen: () => void;
  onRowAction: (action: "archive" | "trash" | "restore") => void;
  onToggleSelect: () => void;
}

function QueueRow({
  message,
  selected,
  checked,
  selectionActive,
  reduceMotion,
  view,
  onOpen,
  onRowAction,
  onToggleSelect,
}: QueueRowProps) {
  const selectionShown = selectionActive || checked;
  const sender = mailboxSenderLabel(message);
  const meta = focusQueueMeta(message);
  const priority = priorityLabel(meta.priority);

  return (
    <div
      className={cn(
        "group/row relative border-b border-border/50 transition-colors duration-150 last:border-b-0",
        selected ? "bg-sel/40" : "hover:bg-page/80",
      )}
    >
      {/* The visual box is 14px, but the label pads the tap target to 40px. */}
      <label
        className={cn(
          "absolute left-0 top-0 z-10 flex h-10 w-10 cursor-pointer items-start justify-start pl-1.5 pt-2 transition-opacity",
          selectionShown ? "opacity-100" : rowRevealClass,
        )}
      >
        <input
          type="checkbox"
          checked={checked}
          aria-label={`Select message from ${sender}`}
          className="h-3.5 w-3.5 rounded border-border accent-orange"
          onChange={(event) => {
            event.stopPropagation();
            onToggleSelect();
          }}
          onClick={(event) => event.stopPropagation()}
        />
      </label>
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? "true" : undefined}
        className="flex w-full min-w-0 items-center gap-2 px-2 py-1.5 pl-4 text-left"
      >
        <span
          className={cn(
            "relative flex h-2 w-2 shrink-0 items-center justify-center transition-opacity",
            selectionShown
              ? "opacity-0"
              : "group-hover/row:opacity-0 [@media(hover:none)]:opacity-0",
          )}
        >
          <AnimatePresence initial={false}>
            {!message.read && (
              <motion.span
                key="unread-dot"
                initial={reduceMotion ? false : { scale: 0.4, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.4, opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                className="h-2 w-2 rounded-full bg-orange"
                aria-hidden="true"
              />
            )}
          </AnimatePresence>
        </span>
        <span
          className={cn(
            "w-11 shrink-0 text-[10px] font-semibold uppercase tracking-wide",
            meta.priority === "now" ? "text-orange" : "text-text-3",
          )}
        >
          {priority}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm transition-colors duration-200",
            message.read ? "text-text-2" : "font-semibold text-text",
          )}
        >
          {message.subject ?? "(no subject)"}
        </span>
        <span className="hidden shrink-0 rounded-sm bg-page px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-3 sm:inline">
          {meta.kindLabel}
        </span>
        <span className="hidden min-w-0 max-w-[7rem] truncate text-xs text-text-3 md:inline">
          {sender}
        </span>
        <time className="shrink-0 text-[11px] text-text-3">
          {formatRelativeTime(message.date)}
        </time>
      </button>
      <div
        className={cn(
          "absolute right-1 top-1 z-10 flex items-center gap-0.5 rounded-lg bg-surface/90 backdrop-blur-sm transition-opacity",
          rowRevealClass,
        )}
      >
        {view === "trash" || view === "archived" ? (
          <RowActionButton
            label={`Restore message from ${sender}`}
            onClick={() => onRowAction("restore")}
          >
            <RotateCcw size={14} aria-hidden="true" />
          </RowActionButton>
        ) : (
          <>
            <RowActionButton
              label={`Archive message from ${sender}`}
              onClick={() => onRowAction("archive")}
            >
              <Archive size={14} aria-hidden="true" />
            </RowActionButton>
            <RowActionButton
              label={`Trash message from ${sender}`}
              onClick={() => onRowAction("trash")}
            >
              <Trash2 size={14} aria-hidden="true" />
            </RowActionButton>
          </>
        )}
      </div>
    </div>
  );
}

function RowActionButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="relative grid h-8 w-8 place-items-center rounded-lg text-text-3 transition after:absolute after:-inset-1 after:content-[''] hover:bg-page hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-orange active:scale-[0.97]"
    >
      {children}
    </button>
  );
}

function QueueEmptyState({
  view,
  kindFilter,
  onClearKindFilter,
}: {
  view: MailboxInboxView;
  kindFilter: CommandQueueKindFilter;
  onClearKindFilter: () => void;
}) {
  if (kindFilter !== "all") {
    const body =
      kindFilter === "system"
        ? "No run notices in the messages loaded here. Older mail may still be further down the full inbox."
        : "No other mail in the messages loaded here. Run notices are hidden for this filter.";
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <span className="grid h-11 w-11 place-items-center rounded-full bg-page text-text-3">
          <InboxIcon size={20} aria-hidden="true" />
        </span>
        <div>
          <p className="text-sm font-medium text-text">
            Nothing in this filter
          </p>
          <p className="mt-1 text-xs text-text-3">{body}</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-8 text-xs"
          onClick={onClearKindFilter}
        >
          Show all kinds
        </Button>
      </div>
    );
  }
  const copy =
    view === "trash"
      ? { title: "Trash is empty", body: "Deleted messages appear here." }
      : view === "archived"
        ? {
            title: "No archived messages",
            body: "Archive mail you want to keep without cluttering your inbox.",
          }
        : view === "unread"
          ? {
              title: "No unread messages",
              body: "You're caught up on new mail.",
            }
          : {
              title: "You're all caught up",
              body: "Briefs and handoffs from Myra and your workflows land here.",
            };
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <span className="grid h-11 w-11 place-items-center rounded-full bg-page text-text-3">
        <InboxIcon size={20} aria-hidden="true" />
      </span>
      <div>
        <p className="text-sm font-medium text-text">{copy.title}</p>
        <p className="mt-1 text-xs text-text-3">{copy.body}</p>
      </div>
    </div>
  );
}
