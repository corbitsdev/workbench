import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { Check, Copy } from "lucide-react";

export interface ChatThreadInfoDialogFields {
  /** Thread title (the sidebar/thread label). */
  readonly title: string;
  /** Agent display name, when the loaded roster/instance payload carries it. */
  readonly agentName?: string;
  /** Model or definition identifier, when the loaded payload carries it. */
  readonly model?: string;
  readonly instanceId: string;
  readonly mailAddress?: string;
  readonly createdAt?: string;
  /** Already-humanized status label; callers omit error-ish/unknown wire statuses. */
  readonly status?: string;
  /** Deep link to this instance's principal trace, when resolvable. */
  readonly traceHref?: string;
}

interface ChatThreadInfoDialogProps extends ChatThreadInfoDialogFields {
  readonly open: boolean;
  readonly onClose: () => void;
}

function formatCreatedAt(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Copy-to-clipboard icon button with a brief "Copied" confirmation state. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        navigator.clipboard
          .writeText(value)
          .then(() => setCopied(true))
          .catch(() => {
            // Clipboard unavailable (permissions); the value stays selectable.
          });
      }}
      className="grid h-6 w-6 flex-none place-items-center rounded-[8px] text-text-3 transition-colors hover:bg-page hover:text-text active:scale-[0.97]"
    >
      {copied ? (
        <>
          <Check className="h-3 w-3" />
          <span className="sr-only" role="status">
            Copied
          </span>
        </>
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  );
}

/**
 * Thread info dialog for the chat thread header. Follows the app's
 * hand-rolled dialog convention (role="dialog", backdrop click and Escape
 * close) established by `WhatsNewDialog`/`AddArtifactModal`. Renders only the
 * fields the caller actually supplied — no placeholders for absent data.
 */
export function ChatThreadInfoDialog({
  open,
  onClose,
  title,
  agentName,
  model,
  instanceId,
  mailAddress,
  createdAt,
  status,
  traceHref,
}: ChatThreadInfoDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    dialogRef.current?.focus();
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [open]);

  if (!open) return null;

  function handleTabTrap(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const container = dialogRef.current;
    if (!container) return;
    const focusable = container.querySelectorAll<HTMLElement>(
      "a[href], button:not([disabled])",
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !container.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const rows: { label: string; value: React.ReactNode }[] = [];
  if (agentName !== undefined) rows.push({ label: "Agent", value: agentName });
  if (model !== undefined) rows.push({ label: "Model", value: model });
  rows.push({
    label: "Instance ID",
    value: (
      <span className="flex min-w-0 items-center justify-end gap-1">
        <span className="min-w-0 break-all font-mono text-xs">
          {instanceId}
        </span>
        <CopyButton value={instanceId} label="Copy instance ID" />
      </span>
    ),
  });
  if (mailAddress !== undefined) {
    rows.push({
      label: "Mail address",
      value: (
        <span className="min-w-0 break-all font-mono text-xs">
          {mailAddress}
        </span>
      ),
    });
  }
  if (createdAt !== undefined) {
    rows.push({ label: "Created", value: formatCreatedAt(createdAt) });
  }
  if (status !== undefined) rows.push({ label: "Status", value: status });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${title} details`}
      className="fixed inset-0 z-[70] grid place-items-center bg-[rgba(0,0,0,0.45)] p-4"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
          return;
        }
        handleTabTrap(event);
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className="flex w-full max-w-[420px] flex-col gap-4 rounded-panel border border-border bg-surface p-5 shadow-xl focus:outline-none"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="min-w-0 truncate text-library-title-sm tracking-[-0.01em] text-text">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 flex-none place-items-center rounded-[9px] border border-border text-text-2 transition-colors hover:bg-page hover:text-text active:scale-[0.97]"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <dl className="flex flex-col gap-2 rounded-[10px] bg-page p-3">
          {rows.map((row) => (
            <div
              key={row.label}
              className="flex items-baseline justify-between gap-3"
            >
              <dt className="shrink-0 text-xs text-text-3">{row.label}</dt>
              <dd className="min-w-0 text-right text-sm text-text">
                {row.value}
              </dd>
            </div>
          ))}
        </dl>

        <div className="flex items-center justify-end gap-4">
          {traceHref !== undefined && (
            <Link
              to={traceHref}
              onClick={onClose}
              className="text-xs font-medium text-orange transition-colors hover:text-orange-deep"
            >
              Open trace
            </Link>
          )}
          <Link
            to="/agents"
            onClick={onClose}
            className="text-xs font-medium text-orange transition-colors hover:text-orange-deep"
          >
            Open Agents page
          </Link>
        </div>
      </div>
    </div>
  );
}
