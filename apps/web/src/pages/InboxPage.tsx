import { useEffect, useMemo } from "react";
import { useNavigate, useParams } from "react-router";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Inbox as InboxIcon } from "lucide-react";
import { cn, Markdown } from "@workbench/ui";
import {
  buildNowFeed,
  type MailboxMessage,
  type MailboxMessageDetail,
} from "@workbench/shared";
import {
  MAILBOX_POLL_MS,
  useMailbox,
  useMailboxMessage,
  useMarkMailboxRead,
} from "../hooks/use-mailbox";
import { useTasks } from "../hooks/use-tasks";
import { useWorkflowRuns } from "../hooks/use-workflow";
import { useActiveWorkbench } from "../lib/active-workbench-context";
import { formatRelativeTime } from "../lib/relative-time";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { NowSection } from "../components/NowSection";

// The Now feed's liveness cadence, shared with the bell's mailbox poll so the
// whole dashboard breathes at one rate.
const NOW_POLL_MS = MAILBOX_POLL_MS;

/**
 * The inbox as the living dashboard: a message-list rail plus a main pane
 * that shows the prioritized "Now" feed (gate asks, unread mail, open tasks)
 * until a message is selected, then its reading pane. Opening a message marks
 * it read so the ambient notifications bell's unread badge stays honest.
 */
export function InboxPage() {
  const { messageId } = useParams<{ messageId?: string }>();
  const navigate = useNavigate();
  const reduceMotion = useReducedMotion();
  const { activeTenantId } = useActiveWorkbench();
  const { data, isLoading, isError, refetch } = useMailbox({
    refetchInterval: NOW_POLL_MS,
  });
  const tasks = useTasks({ refetchInterval: NOW_POLL_MS });
  const runs = useWorkflowRuns(activeTenantId, {
    idleRefetchInterval: NOW_POLL_MS,
  });
  const markRead = useMarkMailboxRead();
  const markReadMutate = markRead.mutate;

  const messages = data ?? [];
  const taskList = tasks.data;
  const runList = runs.data;
  const nowItems = useMemo(
    () =>
      buildNowFeed({
        runs: runList ?? [],
        messages: data ?? [],
        tasks: taskList ?? [],
      }),
    [runList, data, taskList],
  );
  const nowReady = !isLoading && !tasks.isLoading && !runs.isLoading;
  const selected = messages.find((m) => m.id === messageId) ?? null;
  const detail = useMailboxMessage(selected?.id ?? null);

  // Reading a message clears its unread state. Driving this from the selected
  // resource (not the click handler) marks read on a deep-link open too, and
  // deriving a null-when-read id makes it idempotent — an already-read
  // message never re-fires the mutation.
  const unreadSelectedId = selected && !selected.read ? selected.id : null;
  useEffect(() => {
    if (unreadSelectedId !== null) {
      markReadMutate(unreadSelectedId);
    }
  }, [unreadSelectedId, markReadMutate]);

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden">
      <aside className="flex w-80 shrink-0 flex-col border-r border-border bg-surface">
        <header className="flex items-baseline justify-between px-4 py-4">
          <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-text">
            Inbox
          </h1>
          {messages.length > 0 && (
            <span className="text-xs text-text-3">{messages.length}</span>
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <MessageList
            messages={messages}
            selectedId={selected?.id ?? null}
            isLoading={isLoading}
            isError={isError}
            reduceMotion={reduceMotion ?? false}
            onRetry={() => refetch()}
            onOpen={(id) => navigate(`/inbox/${id}`)}
          />
        </div>
      </aside>

      <section className="min-w-0 flex-1 overflow-y-auto bg-page">
        <ErrorBoundary>
          {selected ? (
            <ReadingPane
              message={selected}
              detail={detail.data}
              detailLoading={detail.isLoading}
              detailError={detail.isError}
              reduceMotion={reduceMotion ?? false}
            />
          ) : (
            <NowSection
              items={nowItems}
              ready={nowReady}
              reduceMotion={reduceMotion ?? false}
            />
          )}
        </ErrorBoundary>
      </section>
    </div>
  );
}

interface MessageListProps {
  messages: MailboxMessage[];
  selectedId: string | null;
  isLoading: boolean;
  isError: boolean;
  reduceMotion: boolean;
  onRetry: () => void;
  onOpen: (id: string) => void;
}

function MessageList({
  messages,
  selectedId,
  isLoading,
  isError,
  reduceMotion,
  onRetry,
  onOpen,
}: MessageListProps) {
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
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded-[10px] border border-border px-2.5 py-1.5 text-sm font-medium text-text transition-colors hover:bg-page"
        >
          Try again
        </button>
      </div>
    );
  }

  if (messages.length === 0) {
    return <RailEmptyState />;
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
          <MessageRow
            message={message}
            selected={message.id === selectedId}
            reduceMotion={reduceMotion}
            onOpen={() => onOpen(message.id)}
          />
        </motion.li>
      ))}
    </ul>
  );
}

interface MessageRowProps {
  message: MailboxMessage;
  selected: boolean;
  reduceMotion: boolean;
  onOpen: () => void;
}

function MessageRow({
  message,
  selected,
  reduceMotion,
  onOpen,
}: MessageRowProps) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-[10px] px-3 py-2.5 text-left transition-colors duration-150",
        selected ? "bg-row-hover" : "hover:bg-page",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="relative flex h-2 w-2 shrink-0 items-center justify-center">
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
            "min-w-0 flex-1 truncate text-sm transition-colors duration-200",
            message.read ? "text-text-2" : "font-semibold text-text",
          )}
        >
          {message.from}
        </span>
        <time className="shrink-0 text-[11px] text-text-3">
          {formatRelativeTime(message.date)}
        </time>
      </div>
      <span
        className={cn(
          "truncate pl-4 text-sm transition-colors duration-200",
          message.read ? "text-text-3" : "text-text-2",
        )}
      >
        {message.subject ?? "(no subject)"}
      </span>
      {message.snippet && (
        <span className="truncate pl-4 text-xs text-text-3">
          {message.snippet}
        </span>
      )}
    </button>
  );
}

interface ReadingPaneProps {
  message: MailboxMessage;
  detail: MailboxMessageDetail | undefined;
  detailLoading: boolean;
  detailError: boolean;
  reduceMotion: boolean;
}

function MessageBody({
  detail,
  detailLoading,
  detailError,
}: Pick<ReadingPaneProps, "detail" | "detailLoading" | "detailError">) {
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

function ReadingPane({
  message,
  detail,
  detailLoading,
  detailError,
  reduceMotion,
}: ReadingPaneProps) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.article
        key={message.id}
        initial={reduceMotion ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="mx-auto max-w-[720px] px-8 py-8"
      >
        <h2 className="text-[22px] font-semibold tracking-[-0.01em] text-text">
          {message.subject ?? "(no subject)"}
        </h2>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-2">
          <span className="font-medium text-text">{message.from}</span>
          <span className="text-text-3">·</span>
          <time className="text-text-3">
            {formatRelativeTime(message.date)}
          </time>
        </div>
        <div className="mt-6 border-t border-border pt-6">
          <MessageBody
            detail={detail}
            detailLoading={detailLoading}
            detailError={detailError}
          />
        </div>
      </motion.article>
    </AnimatePresence>
  );
}

function RailEmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <span className="grid h-11 w-11 place-items-center rounded-full bg-page text-text-3">
        <InboxIcon size={20} aria-hidden="true" />
      </span>
      <div>
        <p className="text-sm font-medium text-text">You're all caught up</p>
        <p className="mt-1 text-xs text-text-3">
          Briefs and handoffs from Myra and your workflows land here.
        </p>
      </div>
    </div>
  );
}
