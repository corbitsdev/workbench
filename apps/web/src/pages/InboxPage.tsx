import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Archive,
  ArrowLeft,
  Inbox as InboxIcon,
  RotateCcw,
  Settings,
  Trash2,
} from "lucide-react";
import { AppPageChromeRow, Button, cn, Markdown } from "@workbench/ui";
import { useSetPageChrome } from "../lib/page-chrome";
import type { MailboxInboxView } from "@workbench/shared";
import {
  buildNowFeed,
  openTaskStatuses,
  mailboxSenderLabel,
  type MailboxMessage,
  type MailboxMessageDetail,
  type MailboxRef,
} from "@workbench/shared";
import {
  isMessageNotFound,
  MAILBOX_POLL_MS,
  parseMailboxView,
  useMailbox,
  useMailboxBulkAction,
  useMailboxItemAction,
  useMailboxMessage,
  useMarkMailboxRead,
  useMarkMailboxUnread,
  type MailboxBulkAction,
} from "../hooks/use-mailbox";
import { ApiError } from "../lib/api";
import { isTaskNotFound, useTask, useTasks } from "../hooks/use-tasks";
import { useWorkflowRuns } from "../hooks/use-workflow";
import { useActiveWorkbench } from "../lib/active-workbench-context";
import { formatRelativeTime } from "../lib/relative-time";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { NowSection } from "../components/NowSection";
import { TasksPanel } from "../components/TasksPanel";
import { RefChip } from "../components/RefChip";

// The Now feed's liveness cadence, shared with the bell's mailbox poll so the
// whole dashboard breathes at one rate.
const NOW_POLL_MS = MAILBOX_POLL_MS;

/**
 * The inbox as the living dashboard: a message-list rail plus a main pane
 * that shows the prioritized "Now" feed (gate asks, unread mail, open tasks)
 * until a message is selected, then its reading pane. Opening a message marks
 * it read so the ambient notifications bell's unread badge stays honest.
 */
const INBOX_VIEWS: { id: MailboxInboxView; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "archived", label: "Archived" },
  { id: "trash", label: "Trash" },
];

/** Client-side kind facet (CL-4331). Temporary debt: list API has no kind /
 * messageKey; classify from hub terminal-run subject prefixes only. Prefer a
 * stable write-path class later — do not expand subject heuristics. */
const INBOX_KIND_FILTERS = [
  { id: "all", label: "All" },
  { id: "results", label: "Mail" },
  { id: "system", label: "Run notices" },
] as const;

type InboxKindFilter = (typeof INBOX_KIND_FILTERS)[number]["id"];

/** Matches hub terminal-run subjects only (`Workflow run completed|failed: …`). */
const SYSTEM_RUN_SUBJECT = /^Workflow run (?:completed|failed):\s/i;

export function isSystemWorkflowMail(message: {
  subject?: string | undefined;
}): boolean {
  const subject = message.subject?.trim() ?? "";
  return SYSTEM_RUN_SUBJECT.test(subject);
}

export function parseInboxKindFilter(
  raw: string | null,
): InboxKindFilter | null {
  if (raw === "system" || raw === "results" || raw === "all") return raw;
  return null;
}

export function filterMessagesByKind(
  messages: MailboxMessage[],
  kind: InboxKindFilter,
): MailboxMessage[] {
  if (kind === "all") return messages;
  if (kind === "system") return messages.filter(isSystemWorkflowMail);
  return messages.filter((m) => !isSystemWorkflowMail(m));
}

/** Shared compact control sizing for inbox rail tabs, bulk actions, and load-more. */
const inboxCompactControlClass =
  "inline-flex h-8 shrink-0 items-center justify-center rounded-lg px-3 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-orange disabled:cursor-not-allowed disabled:opacity-50";

const inboxMainPaneClass = "mx-auto max-w-[720px] px-6 py-5";

export function InboxPage() {
  const { messageId } = useParams<{ messageId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedTaskId = searchParams.get("task");
  const inboxView = parseMailboxView(searchParams.get("view")) ?? "all";
  const kindFilter = parseInboxKindFilter(searchParams.get("kind")) ?? "all";
  const navigate = useNavigate();
  const reduceMotion = useReducedMotion();
  const { activeTenantId, activeWorkbench } = useActiveWorkbench();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [inboxActionError, setInboxActionError] = useState<string | null>(null);
  // On mobile the two panes collapse to one column: the message list is the
  // landing view, and this toggle swaps in the live activity/tasks feed. On
  // desktop both panes are always visible, so the toggle is hidden and this
  // state is inert.
  const [mobileTab, setMobileTab] = useState<"messages" | "activity">(
    "messages",
  );
  const { data, isLoading, isError, refetch } = useMailbox({
    view: inboxView,
    refetchInterval: NOW_POLL_MS,
  });
  const {
    data: nowFeedMessages,
    isLoading: nowMailboxLoading,
    hasNextPage: nowMailboxHasNextPage,
    fetchNextPage: fetchNextNowMailboxPage,
    isFetchingNextPage: isFetchingNextNowMailboxPage,
  } = useMailbox({
    view: "all",
    refetchInterval: NOW_POLL_MS,
  });
  const tasks = useTasks({ refetchInterval: NOW_POLL_MS });
  const runs = useWorkflowRuns(activeTenantId, {
    idleRefetchInterval: NOW_POLL_MS,
  });
  const markRead = useMarkMailboxRead();
  const markUnread = useMarkMailboxUnread();
  const bulkAction = useMailboxBulkAction();
  const itemAction = useMailboxItemAction();
  const markReadMutate = markRead.mutate;

  const messages = useMemo(
    () => filterMessagesByKind(data ?? [], kindFilter),
    [data, kindFilter],
  );
  const taskList = tasks.data;
  const runList = runs.data;
  const nowItems = useMemo(
    () =>
      buildNowFeed({
        runs: runList ?? [],
        messages: nowFeedMessages ?? [],
        tasks: taskList ?? [],
      }),
    [runList, nowFeedMessages, taskList],
  );
  const nowReady = !nowMailboxLoading && !tasks.isLoading && !runs.isLoading;
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

  useEffect(() => {
    setSelectedIds(new Set());
  }, [inboxView, kindFilter]);

  const reportInboxActionError = (err: unknown) => {
    if (err instanceof ApiError) {
      setInboxActionError(err.message || "Couldn't update your inbox.");
      return;
    }
    if (err instanceof Error) {
      setInboxActionError(err.message);
      return;
    }
    setInboxActionError("Couldn't update your inbox.");
  };

  const runRowAction = (
    id: string,
    action: "archive" | "trash" | "restore",
  ) => {
    setInboxActionError(null);
    itemAction
      .mutateAsync({ id, action })
      .then(() => {
        if (messageId === id) navigate(inboxPath(inboxView, kindFilter));
      })
      .catch(reportInboxActionError);
  };

  const runBulk = (action: MailboxBulkAction) => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setInboxActionError(null);
    bulkAction
      .mutateAsync({ action, ids })
      .then(() => {
        setSelectedIds(new Set());
        if (messageId && ids.includes(messageId)) {
          navigate(inboxPath(inboxView, kindFilter));
        }
      })
      .catch(reportInboxActionError);
  };

  const pageChrome = useMemo(
    () => (
      <AppPageChromeRow title="Inbox" titleSize="sm">
        {messages.length > 0 && (
          <span className="text-xs text-text-3">{messages.length}</span>
        )}
        <Link
          to="/settings#morning-brief"
          title="Inbox settings"
          aria-label="Inbox settings"
          className="grid h-8 w-8 place-items-center rounded-lg text-text-3 transition-colors hover:bg-page hover:text-text"
        >
          <Settings size={15} aria-hidden="true" />
        </Link>
      </AppPageChromeRow>
    ),
    [messages.length],
  );
  useSetPageChrome(pageChrome);

  const changeView = (next: MailboxInboxView) => {
    const params = new URLSearchParams(searchParams);
    if (next === "all") params.delete("view");
    else params.set("view", next);
    setSearchParams(params, { replace: true });
  };

  const changeKindFilter = (next: InboxKindFilter) => {
    const params = new URLSearchParams(searchParams);
    if (next === "all") params.delete("kind");
    else params.set("kind", next);
    setSearchParams(params, { replace: true });
  };

  const allVisibleSelected =
    messages.length > 0 && messages.every((m) => selectedIds.has(m.id));
  const someVisibleSelected = messages.some((m) => selectedIds.has(m.id));

  const toggleSelectAllVisible = (checked: boolean) => {
    setSelectedIds(checked ? new Set(messages.map((m) => m.id)) : new Set());
  };

  // Single-column mobile: the list is the landing view; the main pane shows
  // either the reading pane (a message is open) or the activity feed (the
  // "Activity" toggle). Exactly one of the two panes is visible below `md`.
  const hasOpenMessage = Boolean(messageId);
  const listHiddenOnMobile = hasOpenMessage || mobileTab === "activity";
  const mainHiddenOnMobile = !hasOpenMessage && mobileTab === "messages";

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden md:flex-row">
      {!hasOpenMessage && (
        <MobileInboxTabs tab={mobileTab} onChange={setMobileTab} />
      )}
      <aside
        className={cn(
          "flex min-h-0 flex-1 flex-col border-b border-border bg-surface md:w-80 md:flex-none md:shrink-0 md:border-b-0 md:border-r",
          listHiddenOnMobile && "max-md:hidden",
        )}
      >
        <InboxRailHeader
          view={inboxView}
          kindFilter={kindFilter}
          selectedCount={selectedIds.size}
          allVisibleSelected={allVisibleSelected}
          someVisibleSelected={someVisibleSelected}
          hasVisibleMessages={messages.length > 0}
          bulkBusy={bulkAction.isPending}
          onChangeView={changeView}
          onChangeKindFilter={changeKindFilter}
          onToggleSelectAll={toggleSelectAllVisible}
          onClearSelection={() => setSelectedIds(new Set())}
          onBulk={runBulk}
        />
        {inboxActionError && (
          <p className="mx-3 mb-2 text-sm text-red-600" role="alert">
            {inboxActionError}
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <MessageList
            messages={messages}
            selectedId={listRow?.id ?? null}
            selectedIds={selectedIds}
            isLoading={isLoading}
            isError={isError}
            reduceMotion={reduceMotion ?? false}
            view={inboxView}
            kindFilter={kindFilter}
            onRetry={() => refetch()}
            onOpen={(id) =>
              navigate(inboxMessagePath(inboxView, id, kindFilter))
            }
            onRowAction={runRowAction}
            onToggleSelect={(id) => {
              setSelectedIds((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
            onClearKindFilter={() => changeKindFilter("all")}
          />
        </div>
      </aside>

      <section
        className={cn(
          "min-w-0 flex-1 overflow-y-auto bg-page",
          mainHiddenOnMobile && "max-md:hidden",
        )}
      >
        <ErrorBoundary>
          {messageId ? (
            <ReadingPane
              headerSource={headerSource}
              detail={detail.data}
              detailLoading={detail.isLoading}
              detailNotFound={isMessageNotFound(detail.error)}
              detailError={detail.isError}
              reduceMotion={reduceMotion ?? false}
              view={inboxView}
              busy={itemAction.isPending || markUnread.isPending}
              onClose={() => {
                // "Back to inbox" must always land on the message list on
                // mobile, even when the message was opened from the Activity
                // pane — a stale "activity" tab would otherwise hide the list.
                setMobileTab("messages");
                navigate(inboxPath(inboxView, kindFilter));
              }}
              onMarkUnread={() => {
                if (!messageId) return;
                setInboxActionError(null);
                markUnread.mutateAsync(messageId).catch(reportInboxActionError);
              }}
              onTrash={() => {
                if (!messageId) return;
                setInboxActionError(null);
                itemAction
                  .mutateAsync({ id: messageId, action: "trash" })
                  .then(() => navigate(inboxPath("trash", kindFilter)))
                  .catch(reportInboxActionError);
              }}
              onArchive={() => {
                if (!messageId) return;
                setInboxActionError(null);
                itemAction
                  .mutateAsync({ id: messageId, action: "archive" })
                  .then(() => navigate(inboxPath("archived", kindFilter)))
                  .catch(reportInboxActionError);
              }}
              onRestore={() => {
                if (!messageId) return;
                setInboxActionError(null);
                itemAction
                  .mutateAsync({ id: messageId, action: "restore" })
                  .then(() => navigate(inboxPath("all", kindFilter)))
                  .catch(reportInboxActionError);
              }}
            />
          ) : (
            <>
              {selectedTaskNotice && (
                <p
                  className={cn(
                    inboxMainPaneClass,
                    "py-0 pt-3 text-xs text-text-3",
                  )}
                >
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
              {nowReady ? (
                <div className={cn(inboxMainPaneClass, "w-full py-0 pb-3")}>
                  <TasksPanel tasks={taskList ?? []} />
                </div>
              ) : null}
              <LoadMoreControl
                hasMore={
                  Boolean(nowMailboxHasNextPage) || Boolean(tasks.hasNextPage)
                }
                loading={
                  isFetchingNextNowMailboxPage ||
                  Boolean(tasks.isFetchingNextPage)
                }
                onClick={() => {
                  if (nowMailboxHasNextPage) void fetchNextNowMailboxPage();
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

function inboxPath(
  view: MailboxInboxView,
  kind: InboxKindFilter = "all",
): string {
  const params = new URLSearchParams();
  if (view !== "all") params.set("view", view);
  if (kind !== "all") params.set("kind", kind);
  const qs = params.toString();
  return qs ? `/inbox?${qs}` : "/inbox";
}

function inboxMessagePath(
  view: MailboxInboxView,
  id: string,
  kind: InboxKindFilter = "all",
): string {
  const params = new URLSearchParams();
  if (view !== "all") params.set("view", view);
  if (kind !== "all") params.set("kind", kind);
  const qs = params.toString();
  return qs ? `/inbox/${id}?${qs}` : `/inbox/${id}`;
}

interface MessageListProps {
  messages: MailboxMessage[];
  selectedId: string | null;
  selectedIds: Set<string>;
  isLoading: boolean;
  isError: boolean;
  reduceMotion: boolean;
  view: MailboxInboxView;
  kindFilter: InboxKindFilter;
  onRetry: () => void;
  onOpen: (id: string) => void;
  onRowAction: (id: string, action: "archive" | "trash" | "restore") => void;
  onToggleSelect: (id: string) => void;
  onClearKindFilter: () => void;
}

function MessageList({
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
      <RailEmptyState
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
          <MessageRow
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

interface MessageRowProps {
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

// Hover-revealed controls also show on focus and on no-hover (touch) devices —
// a `:hover`-only reveal would make them unreachable there.
const rowRevealClass =
  "opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100";

function MessageRow({
  message,
  selected,
  checked,
  selectionActive,
  reduceMotion,
  view,
  onOpen,
  onRowAction,
  onToggleSelect,
}: MessageRowProps) {
  const selectionShown = selectionActive || checked;
  const sender = mailboxSenderLabel(message);
  return (
    <div
      className={cn(
        "group/row relative border-b border-border/50 transition-colors duration-150 last:border-b-0",
        selected ? "bg-row-hover/80" : "hover:bg-page/80",
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
        className="flex w-full min-w-0 flex-col gap-0.5 px-2 py-1.5 text-left"
      >
        <div className="flex items-center gap-2">
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

interface ReadingPaneProps {
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
  view,
  busy,
  onClose,
  onMarkUnread,
  onTrash,
  onArchive,
  onRestore,
}: ReadingPaneProps) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.article
        key={headerSource?.id ?? "pending"}
        initial={reduceMotion ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className={inboxMainPaneClass}
      >
        <button
          type="button"
          onClick={onClose}
          className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-text-3 transition hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-orange active:scale-[0.97]"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          Back to inbox
        </button>
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
            <InboxMessageActions
              read={headerSource.read}
              view={view}
              busy={busy}
              onMarkUnread={onMarkUnread}
              onTrash={onTrash}
              onArchive={onArchive}
              onRestore={onRestore}
            />
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
        <RefChip key={`${ref.kind}:${ref.ref}:${index}`} refItem={ref} />
      ))}
    </nav>
  );
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
    <div className={cn(inboxMainPaneClass, "py-0 pb-5")}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-8 w-full text-xs"
        onClick={onClick}
        disabled={loading}
      >
        {loading ? "Loading…" : "Show older"}
      </Button>
    </div>
  );
}

function RailEmptyState({
  view,
  kindFilter,
  onClearKindFilter,
}: {
  view: MailboxInboxView;
  kindFilter: InboxKindFilter;
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
          <p className="text-sm font-medium text-text">Nothing in this filter</p>
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

// The rail's top bar. With nothing selected it is the folder tabs
// (All/Unread/Archived/Trash); the moment messages are checked, the bulk
// actions take over the same row rather than pushing in a second bar.
// Kind facet stays visible so the active filter is never hidden mid-bulk.
function InboxRailHeader({
  view,
  kindFilter,
  selectedCount,
  allVisibleSelected,
  someVisibleSelected,
  hasVisibleMessages,
  bulkBusy,
  onChangeView,
  onChangeKindFilter,
  onToggleSelectAll,
  onClearSelection,
  onBulk,
}: {
  view: MailboxInboxView;
  kindFilter: InboxKindFilter;
  selectedCount: number;
  allVisibleSelected: boolean;
  someVisibleSelected: boolean;
  hasVisibleMessages: boolean;
  bulkBusy: boolean;
  onChangeView: (view: MailboxInboxView) => void;
  onChangeKindFilter: (kind: InboxKindFilter) => void;
  onToggleSelectAll: (checked: boolean) => void;
  onClearSelection: () => void;
  onBulk: (action: MailboxBulkAction) => void;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <div className="flex min-h-[45px] flex-col gap-1 border-b border-border px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {hasVisibleMessages ? (
          <label className="flex h-10 min-w-10 shrink-0 cursor-pointer items-center justify-center gap-1.5 px-1 text-xs text-text-3">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 rounded border-border accent-orange"
              checked={allVisibleSelected}
              ref={(el) => {
                if (el) {
                  el.indeterminate = someVisibleSelected && !allVisibleSelected;
                }
              }}
              disabled={bulkBusy}
              onChange={(e) => onToggleSelectAll(e.target.checked)}
              aria-label="Select all visible messages"
            />
            <span className="sr-only">Select all visible</span>
          </label>
        ) : null}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={selectedCount > 0 ? "bulk" : "tabs"}
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1"
          >
            {selectedCount > 0 ? (
              <InboxBulkActions
                count={selectedCount}
                view={view}
                busy={bulkBusy}
                onClear={onClearSelection}
                onBulk={onBulk}
              />
            ) : (
              <nav aria-label="Inbox views" className="flex gap-1">
                {INBOX_VIEWS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => onChangeView(tab.id)}
                    aria-pressed={view === tab.id}
                    className={cn(
                      inboxCompactControlClass,
                      view === tab.id
                        ? "bg-page text-text"
                        : "text-text-3 hover:bg-page hover:text-text-2",
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </nav>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
      <nav aria-label="Message kind" className="flex gap-1 pb-0.5">
        {INBOX_KIND_FILTERS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChangeKindFilter(tab.id)}
            aria-pressed={kindFilter === tab.id}
            className={cn(
              "inline-flex h-8 shrink-0 items-center justify-center rounded-lg px-2.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-orange",
              kindFilter === tab.id
                ? "bg-page text-text"
                : "text-text-3 hover:bg-page/70 hover:text-text-2",
            )}
          >
            {tab.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

// The mobile-only Messages/Activity switch. On desktop both panes are always
// visible so this is hidden; below `md` it flips which single pane shows.
function MobileInboxTabs({
  tab,
  onChange,
}: {
  tab: "messages" | "activity";
  onChange: (tab: "messages" | "activity") => void;
}) {
  const tabs: { id: "messages" | "activity"; label: string }[] = [
    { id: "messages", label: "Messages" },
    { id: "activity", label: "Activity" },
  ];
  return (
    <nav
      aria-label="Inbox section"
      className="flex gap-1 border-b border-border bg-surface px-2 py-1.5 md:hidden"
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          aria-current={tab === t.id ? "page" : undefined}
          className={cn(
            inboxCompactControlClass,
            "flex-1",
            tab === t.id
              ? "bg-page text-text"
              : "text-text-3 hover:bg-page hover:text-text-2",
          )}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}

function InboxBulkActions({
  count,
  view,
  busy,
  onClear,
  onBulk,
}: {
  count: number;
  view: MailboxInboxView;
  busy: boolean;
  onClear: () => void;
  onBulk: (action: MailboxBulkAction) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="font-medium text-text">{count} selected</span>
      {view === "trash" || view === "archived" ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 text-xs"
          disabled={busy}
          onClick={() => onBulk("restore")}
        >
          Restore
        </Button>
      ) : (
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            disabled={busy}
            onClick={() => onBulk("mark_read")}
          >
            Mark read
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            disabled={busy}
            onClick={() => onBulk("mark_unread")}
          >
            Mark unread
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            disabled={busy}
            onClick={() => onBulk("archive")}
          >
            Archive
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            disabled={busy}
            onClick={() => onBulk("trash")}
          >
            Trash
          </Button>
        </>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 text-xs text-text-3 hover:text-text"
        onClick={onClear}
      >
        Clear
      </Button>
    </div>
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
  read: boolean;
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
