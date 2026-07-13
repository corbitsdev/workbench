import { useEffect, useMemo } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Inbox as InboxIcon, Settings } from "lucide-react";
import { cn, Markdown } from "@workbench/ui";
import {
  buildNowFeed,
  openTaskStatuses,
  mailboxSenderLabel,
  mailboxRefHref,
  isExternalMailboxRef,
  type MailboxMessage,
  type MailboxMessageDetail,
  type MailboxRef,
} from "@workbench/shared";
import {
  isMessageNotFound,
  MAILBOX_POLL_MS,
  useMailbox,
  useMailboxMessage,
  useMarkMailboxRead,
} from "../hooks/use-mailbox";
import { isTaskNotFound, useTask, useTasks } from "../hooks/use-tasks";
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
  const [searchParams] = useSearchParams();
  const selectedTaskId = searchParams.get("task");
  const navigate = useNavigate();
  const reduceMotion = useReducedMotion();
  const { activeTenantId, activeWorkbench } = useActiveWorkbench();
  const {
    data,
    isLoading,
    isError,
    refetch,
    hasNextPage: mailboxHasNextPage,
    fetchNextPage: fetchNextMailboxPage,
    isFetchingNextPage: isFetchingNextMailboxPage,
  } = useMailbox({
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
  const taskInFeed =
    selectedTaskId !== null &&
    nowItems.some(
      (item) => item.type === "task" && item.task.id === selectedTaskId,
    );
  // A deep-linked task the loaded /me/tasks pages don't cover yet is not
  // necessarily gone — fetch it by id directly so the notice can tell "still
  // open, just further down your feed" apart from "no longer open" apart
  // from "no longer exists", instead of flatly claiming it's missing.
  const taskLookup = useTask(
    nowReady && selectedTaskId !== null && !taskInFeed ? selectedTaskId : null,
  );
  const selectedTaskNotice = describeMissingTaskNotice({
    selectedTaskId,
    nowReady,
    taskInFeed,
    taskLookup,
  });

  // The pane's identity comes from the route param alone — never from list
  // membership — so a deep link to a message beyond the loaded mailbox pages
  // still opens: `useMailboxMessage` fetches its full detail directly by id.
  // The loaded row (when present) still drives the rail's highlight.
  const listRow = messages.find((m) => m.id === messageId) ?? null;
  const detail = useMailboxMessage(messageId ?? null);
  // Header fields (subject/from/date) prefer the loaded list row, falling
  // back to the detail fetch's own copy of those fields for a message that
  // isn't in the loaded pages.
  const headerSource: MailboxMessage | MailboxMessageDetail | null =
    listRow ?? detail.data ?? null;

  // Reading a message clears its unread state. Driving this from the loaded
  // list row (not the click handler) marks read on a deep-link open too, and
  // deriving a null-when-read id makes it idempotent — an already-read
  // message never re-fires the mutation. A message beyond the loaded pages
  // isn't marked read here; it will be the next time its page loads.
  const unreadSelectedId = listRow && !listRow.read ? listRow.id : null;
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
          <div className="flex items-center gap-2">
            {messages.length > 0 && (
              <span className="text-xs text-text-3">{messages.length}</span>
            )}
            <Link
              to="/settings#morning-brief"
              title="Inbox settings"
              aria-label="Inbox settings"
              className="grid h-7 w-7 place-items-center rounded-[8px] text-text-3 transition-colors hover:bg-page hover:text-text"
            >
              <Settings size={15} aria-hidden="true" />
            </Link>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <MessageList
            messages={messages}
            selectedId={listRow?.id ?? null}
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
          {messageId ? (
            <ReadingPane
              headerSource={headerSource}
              detail={detail.data}
              detailLoading={detail.isLoading}
              detailNotFound={isMessageNotFound(detail.error)}
              detailError={detail.isError}
              reduceMotion={reduceMotion ?? false}
            />
          ) : (
            <>
              {selectedTaskNotice && (
                <p className="mx-auto max-w-[720px] px-8 pt-4 text-xs text-text-3">
                  {selectedTaskNotice}
                </p>
              )}
              <NowSection
                items={nowItems}
                ready={nowReady}
                reduceMotion={reduceMotion ?? false}
                selectedTaskId={selectedTaskId}
                tenantId={activeTenantId}
                myPrincipalId={activeWorkbench?.id ?? null}
              />
              <LoadMoreControl
                hasMore={
                  Boolean(mailboxHasNextPage) || Boolean(tasks.hasNextPage)
                }
                loading={
                  isFetchingNextMailboxPage || Boolean(tasks.isFetchingNextPage)
                }
                onClick={() => {
                  if (mailboxHasNextPage) void fetchNextMailboxPage();
                  if (tasks.hasNextPage) void tasks.fetchNextPage();
                }}
              />
            </>
          )}
        </ErrorBoundary>
      </section>
    </div>
  );
}

// Resolves the honest notice for a `?task=<id>` deep link that matches no row
// in the loaded Now feed. Rather than flatly claiming the task is gone (which
// is often false — it may simply be further down an unloaded page), this
// fetches the task by id and reports what's actually true: still open (just
// unloaded), no longer open, or genuinely absent. Returns null while there is
// nothing to say (no id selected, sources still loading, or the task is
// already visible in the feed).
function describeMissingTaskNotice(input: {
  selectedTaskId: string | null;
  nowReady: boolean;
  taskInFeed: boolean;
  taskLookup: ReturnType<typeof useTask>;
}): string | null {
  const { selectedTaskId, nowReady, taskInFeed, taskLookup } = input;
  if (selectedTaskId === null || !nowReady || taskInFeed) return null;
  if (taskLookup.isLoading) return null;
  if (taskLookup.data) {
    const openStatuses: readonly string[] = openTaskStatuses;
    if (openStatuses.includes(taskLookup.data.status)) {
      return "That task is further down your feed — use Show older to bring it in.";
    }
    return "That task is no longer open.";
  }
  if (isTaskNotFound(taskLookup.error)) {
    return "That task is no longer in your feed.";
  }
  // Any other lookup failure (network, 5xx): fall back to the same honest
  // wording as "not found" rather than inventing a distinct error copy for a
  // transient failure — the notice is advisory, not the source of truth.
  return "That task is no longer in your feed.";
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
          {mailboxSenderLabel(message)}
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
  headerSource: MailboxMessage | MailboxMessageDetail | null;
  detail: MailboxMessageDetail | undefined;
  detailLoading: boolean;
  detailNotFound: boolean;
  detailError: boolean;
  reduceMotion: boolean;
}

function MessageBody({
  detail,
  detailLoading,
  detailNotFound,
  detailError,
}: Pick<
  ReadingPaneProps,
  "detail" | "detailLoading" | "detailNotFound" | "detailError"
>) {
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

// Renders off the id-keyed detail fetch, not list membership — a message
// beyond the loaded mailbox pages still gets its own pane the moment its
// detail resolves. `headerSource` prefers the loaded list row (has the fields
// instantly) and falls back to the detail response itself (which carries the
// same subject/from/date fields), so a deep link to an unloaded message still
// shows a real header instead of nothing.
function ReadingPane({
  headerSource,
  detail,
  detailLoading,
  detailNotFound,
  detailError,
  reduceMotion,
}: ReadingPaneProps) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.article
        key={headerSource?.id ?? "pending"}
        initial={reduceMotion ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="mx-auto max-w-[720px] px-8 py-8"
      >
        {headerSource && (
          <>
            <h2 className="text-[22px] font-semibold tracking-[-0.01em] text-text">
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
          </>
        )}
        <RelatedRefs refs={headerSource?.refs ?? detail?.refs} />
        <div
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

// The structured "Related" action row: one clickable chip per typed ref on the
// message. Internal refs (artifact/workflow_run/task/mail) route in-app via the
// deepLink helper; external refs (linear/url) open in a new tab.
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
        <RelatedRefChip key={`${ref.kind}:${ref.ref}:${index}`} refItem={ref} />
      ))}
    </nav>
  );
}

function RelatedRefChip({ refItem }: { refItem: MailboxRef }) {
  const label = refItem.label ?? defaultRefLabel(refItem);
  const chipClass =
    "inline-flex items-center rounded-full border border-border bg-surface px-2.5 py-1 text-xs font-medium text-text-2 transition-colors hover:bg-row-hover hover:text-text";
  if (isExternalMailboxRef(refItem)) {
    return (
      <a
        href={mailboxRefHref(refItem)}
        target="_blank"
        rel="noreferrer"
        className={chipClass}
      >
        {label}
      </a>
    );
  }
  return (
    <Link to={mailboxRefHref(refItem)} className={chipClass}>
      {label}
    </Link>
  );
}

function defaultRefLabel(ref: MailboxRef): string {
  switch (ref.kind) {
    case "artifact":
      return "Open artifact";
    case "workflow_run":
      return "Open run";
    case "task":
      return "Open task";
    case "mail":
      return "Open message";
    case "linear":
      return "Open in Linear";
    case "url":
      return "Open link";
  }
}

interface LoadMoreControlProps {
  hasMore: boolean;
  loading: boolean;
  onClick: () => void;
}

// The single explicit affordance for the growable /inbox surfaces (mailbox,
// tasks) — no scroll-sentinel machinery, just one quiet control at the feed's
// end that fetches whichever source(s) still have another page.
function LoadMoreControl({ hasMore, loading, onClick }: LoadMoreControlProps) {
  if (!hasMore) return null;
  return (
    <div className="mx-auto max-w-[720px] px-8 pb-8">
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        className="w-full rounded-[10px] border border-border px-2.5 py-1.5 text-xs font-medium text-text-2 transition-colors hover:bg-page hover:text-text disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Loading…" : "Show older"}
      </button>
    </div>
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
