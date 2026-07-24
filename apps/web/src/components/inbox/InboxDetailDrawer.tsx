import { Link } from "react-router";
import { AnimatePresence, motion } from "framer-motion";
import { Archive, ArrowLeft, Trash2 } from "lucide-react";
import { Button, buttonVariants, cn, Markdown } from "@workbench/ui";
import {
  focusQueueMeta,
  mailboxSenderLabel,
  primaryMailActionHref,
  type MailboxInboxView,
  type MailboxMessage,
  type MailboxMessageDetail,
  type MailboxRef,
} from "@workbench/shared";
import { formatRelativeTime } from "../../lib/relative-time";
import { RefChip } from "../RefChip";

const detailPaneClass = "mx-auto max-w-[720px] px-6 py-5";

interface InboxDetailDrawerProps {
  headerSource: MailboxMessage | MailboxMessageDetail | null;
  detail: MailboxMessageDetail | undefined;
  detailLoading: boolean;
  detailNotFound: boolean;
  detailError: boolean;
  reduceMotion: boolean;
  view: MailboxInboxView;
  busy: boolean;
  onClose: () => void;
  onMarkUnread: () => void;
  onTrash: () => void;
  onArchive: () => void;
  onRestore: () => void;
}

/**
 * Selected-message detail drawer for the hybrid inbox: kind, summary,
 * recommended next step, primary + secondary focus actions, plus the
 * existing archive/trash/mark-unread hygiene controls.
 */
export function InboxDetailDrawer({
  headerSource,
  detail,
  detailLoading,
  detailNotFound,
  detailError,
  reduceMotion,
  view,
  busy,
  onClose,
  onMarkUnread,
  onTrash,
  onArchive,
  onRestore,
}: InboxDetailDrawerProps) {
  const focus = headerSource ? focusQueueMeta(headerSource) : null;
  const primaryHref = headerSource ? primaryMailActionHref(headerSource) : null;

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.article
        key={headerSource?.id ?? "pending"}
        initial={reduceMotion ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className={detailPaneClass}
      >
        <button
          type="button"
          onClick={onClose}
          className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-text-3 transition hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-orange active:scale-[0.97]"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          Back to inbox
        </button>
        {headerSource && focus ? (
          <>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-orange">
              {focus.kindLabel}
            </p>
            <h2 className="text-xl font-semibold tracking-[-0.01em] text-text">
              {headerSource.subject ?? "(no subject)"}
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-2">
              <span className="font-medium text-text">
                {mailboxSenderLabel(headerSource)}
              </span>
              <span className="text-text-3">·</span>
              <time className="text-text-3">
                {formatRelativeTime(headerSource.date)}
              </time>
            </div>
            {focus.summary ? (
              <p className="mt-3 text-sm leading-relaxed text-text-2">
                {focus.summary}
              </p>
            ) : null}
            <div className="mt-4 rounded-xl border border-orange/20 bg-orange/5 px-3.5 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-orange">
                Recommended
              </p>
              <p className="mt-1 text-sm leading-relaxed text-text-2">
                {focus.guidance}
              </p>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {primaryHref ? (
                <Link
                  to={primaryHref}
                  className={cn(
                    buttonVariants({ variant: "primary", size: "sm" }),
                    "inline-flex h-8 items-center text-xs",
                  )}
                >
                  {focus.primaryAction}
                </Link>
              ) : (
                <Button
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => {
                    document
                      .getElementById("inbox-message-body")
                      ?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                >
                  {focus.primaryAction}
                </Button>
              )}
              {focus.secondaryAction && focus.secondaryAction !== "Archive" ? (
                <SecondaryFocusButton
                  label={focus.secondaryAction}
                  view={view}
                  busy={busy}
                  onArchive={onArchive}
                  onClose={onClose}
                  onRestore={onRestore}
                />
              ) : null}
            </div>
            <InboxMessageActions
              view={view}
              busy={busy}
              onMarkUnread={onMarkUnread}
              onTrash={onTrash}
              onArchive={onArchive}
              onRestore={onRestore}
            />
          </>
        ) : null}
        <RelatedRefs refs={headerSource?.refs ?? detail?.refs} />
        <div
          id="inbox-message-body"
          className={cn(
            "border-t border-border pt-6",
            headerSource ? "mt-6" : "mt-0",
          )}
        >
          <MessageBody
            detail={detail}
            detailLoading={detailLoading}
            detailNotFound={detailNotFound}
            detailError={detailError}
          />
        </div>
      </motion.article>
    </AnimatePresence>
  );
}

function SecondaryFocusButton({
  label,
  view,
  busy,
  onArchive,
  onClose,
  onRestore,
}: {
  label: string;
  view: MailboxInboxView;
  busy: boolean;
  onArchive: () => void;
  onClose: () => void;
  onRestore: () => void;
}) {
  if (view === "trash" || view === "archived") {
    return (
      <Button
        size="sm"
        variant="secondary"
        className="h-8 text-xs"
        disabled={busy}
        onClick={onRestore}
      >
        Restore
      </Button>
    );
  }
  if (label === "Later") {
    return (
      <Button
        size="sm"
        variant="secondary"
        className="h-8 text-xs"
        onClick={onClose}
      >
        Dismiss
      </Button>
    );
  }
  if (label === "Archive") {
    return (
      <Button
        size="sm"
        variant="secondary"
        className="h-8 text-xs"
        disabled={busy}
        onClick={onArchive}
      >
        Archive
      </Button>
    );
  }
  return (
    <Button size="sm" variant="secondary" className="h-8 text-xs" disabled>
      {label}
    </Button>
  );
}

function MessageBody({
  detail,
  detailLoading,
  detailNotFound,
  detailError,
}: {
  detail: MailboxMessageDetail | undefined;
  detailLoading: boolean;
  detailNotFound: boolean;
  detailError: boolean;
}) {
  if (detailNotFound) {
    return <p className="text-sm text-text-3">This message is unavailable.</p>;
  }
  if (detailLoading) {
    return (
      <p className="text-sm text-text-3" role="status">
        Loading message…
      </p>
    );
  }
  if (detailError) {
    return <p className="text-sm text-text-3">Couldn't load this message.</p>;
  }
  if (!detail || detail.body.length === 0) {
    return (
      <p className="text-sm italic text-text-3">
        No content available for this message.
      </p>
    );
  }
  // Briefs and handoffs are markdown text, so the pane renders through the
  // shared Markdown component rather than pre-wrapped plain text.
  return <Markdown>{detail.body}</Markdown>;
}

function RelatedRefs({ refs }: { refs: MailboxRef[] | undefined }) {
  if (!refs || refs.length === 0) return null;
  return (
    <nav
      aria-label="Related"
      className="mt-4 flex flex-wrap items-center gap-2"
    >
      <span className="text-xs font-medium uppercase tracking-wide text-text-3">
        Related
      </span>
      {refs.map((ref, index) => (
        <RefChip key={`${ref.kind}:${ref.ref}:${index}`} refItem={ref} />
      ))}
    </nav>
  );
}

function InboxMessageActions({
  view,
  busy,
  onMarkUnread,
  onTrash,
  onArchive,
  onRestore,
}: {
  view: MailboxInboxView;
  busy: boolean;
  onMarkUnread: () => void;
  onTrash: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {view === "trash" || view === "archived" ? (
        <Button
          size="sm"
          variant="secondary"
          className="h-8 text-xs"
          disabled={busy}
          onClick={onRestore}
        >
          Restore to inbox
        </Button>
      ) : (
        <>
          <Button
            size="sm"
            variant="secondary"
            className="h-8 text-xs"
            disabled={busy}
            onClick={onMarkUnread}
          >
            Mark unread
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="h-8 text-xs"
            disabled={busy}
            onClick={onArchive}
          >
            <Archive size={14} className="mr-1 inline" aria-hidden />
            Archive
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="h-8 text-xs"
            disabled={busy}
            onClick={onTrash}
          >
            <Trash2 size={14} className="mr-1 inline" aria-hidden />
            Trash
          </Button>
        </>
      )}
    </div>
  );
}
