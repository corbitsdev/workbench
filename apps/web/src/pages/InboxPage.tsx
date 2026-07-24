import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Settings } from "lucide-react";
import { AppPageChromeRow, Button, cn } from "@workbench/ui";
import { useSetPageChrome } from "../lib/page-chrome";
import type { MailboxInboxView } from "@workbench/shared";
import {
  buildNowFeed,
  isSystemWorkflowMail,
  openTaskStatuses,
  selectNowCards,
  type MailboxMessage,
  type MailboxMessageDetail,
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
import { ErrorBoundary } from "../components/ErrorBoundary";
import { CommandQueue } from "../components/inbox/CommandQueue";
import { InboxDetailDrawer } from "../components/inbox/InboxDetailDrawer";
import { NowCardsStrip } from "../components/inbox/NowCardsStrip";

// Re-export for tests that import classification from the page module.
export { isSystemWorkflowMail };

// The Now feed's liveness cadence, shared with the bell's mailbox poll so the
// whole dashboard breathes at one rate.
const NOW_POLL_MS = MAILBOX_POLL_MS;

/**
 * Hybrid Focus inbox (CL-4397): Dia-style Now cards on top, Linear-dense
 * command queue as the primary list, detail drawer for the open message.
 * Opening a message marks it read so the ambient notifications bell stays honest.
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

export function InboxPage() {
  const { messageId } = useParams<{ messageId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedTaskId = searchParams.get("task");
  const inboxView = parseMailboxView(searchParams.get("view")) ?? "all";
  const kindFilter = parseInboxKindFilter(searchParams.get("kind")) ?? "all";
  const navigate = useNavigate();
  const reduceMotion = useReducedMotion();
  const { activeTenantId } = useActiveWorkbench();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [inboxActionError, setInboxActionError] = useState<string | null>(null);
  const {
    data,
    isLoading,
    isError,
    refetch,
    hasNextPage: queueHasNextPage,
    fetchNextPage: fetchNextQueuePage,
    isFetchingNextPage: isFetchingNextQueuePage,
  } = useMailbox({
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
  const nowCards = useMemo(() => selectNowCards(nowItems, 3), [nowItems]);
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

  // Mobile: queue is landing; open message swaps to the drawer.
  // Desktop: queue is full-width until a row opens, then eases to ~33% so
  // the detail pane owns the rest (and Now collapses).
  const hasOpenMessage = Boolean(messageId);
  const listHiddenOnMobile = hasOpenMessage;
  const mainHiddenOnMobile = !hasOpenMessage;
  const paneMotionClass = reduceMotion
    ? "transition-none"
    : "transition-[width,flex-grow,opacity] duration-300 ease-[var(--ease)]";
  const detailPaneRef = useRef<HTMLElement>(null);

  // Hand focus into the detail region when a message opens so AT/keyboard
  // users do not stay on a Now card that just became inert.
  useEffect(() => {
    if (!messageId) return;
    detailPaneRef.current?.focus({ preventScroll: true });
  }, [messageId]);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <NowCardsStrip
        cards={nowCards}
        ready={nowReady}
        selectedMailId={messageId ?? null}
        selectedTaskId={selectedTaskId}
        collapsed={hasOpenMessage}
        reduceMotion={reduceMotion ?? false}
      />
      {selectedTaskNotice ? (
        <p className="shrink-0 border-b border-border bg-page px-4 py-2 text-xs text-text-3">
          {selectedTaskNotice}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
        <aside
          className={cn(
            "flex min-h-0 flex-col border-b border-border bg-surface md:border-b-0",
            paneMotionClass,
            // Closed: full-width queue (no trailing border). Open: ~⅓ rail +
            // divider against the detail pane.
            hasOpenMessage
              ? "flex-1 md:min-w-[280px] md:w-[min(34%,420px)] md:flex-none md:shrink-0 md:border-r"
              : "min-h-0 flex-1 md:w-full",
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
            <p className="mx-3 mb-2 text-sm text-red" role="alert">
              {inboxActionError}
            </p>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            <p className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-3">
              Command queue
            </p>
            <CommandQueue
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
            {nowReady &&
            (queueHasNextPage ||
              (inboxView !== "all" && nowMailboxHasNextPage) ||
              tasks.hasNextPage) ? (
              <div className="px-2 pt-2">
                <LoadMoreControl
                  hasMore={
                    Boolean(queueHasNextPage) ||
                    (inboxView !== "all" && Boolean(nowMailboxHasNextPage)) ||
                    Boolean(tasks.hasNextPage)
                  }
                  loading={
                    isFetchingNextQueuePage ||
                    (inboxView !== "all" && isFetchingNextNowMailboxPage) ||
                    Boolean(tasks.isFetchingNextPage)
                  }
                  onClick={() => {
                    // Queue and Now share the `all` query key — only fetch
                    // the Now mailbox separately when the rail is on another view.
                    if (queueHasNextPage) void fetchNextQueuePage();
                    if (inboxView !== "all" && nowMailboxHasNextPage) {
                      void fetchNextNowMailboxPage();
                    }
                    if (tasks.hasNextPage) void tasks.fetchNextPage();
                  }}
                />
              </div>
            ) : null}
          </div>
        </aside>

        <section
          ref={detailPaneRef}
          tabIndex={-1}
          aria-hidden={!hasOpenMessage}
          className={cn(
            "min-w-0 bg-page outline-none",
            paneMotionClass,
            // Stay in the flex tree so width/opacity can ease. Closed: zero
            // width + no hit testing. Open: grow into the majority of the page.
            hasOpenMessage
              ? "flex-1 overflow-y-auto opacity-100"
              : "pointer-events-none w-0 flex-none overflow-hidden opacity-0",
            mainHiddenOnMobile && "max-md:hidden",
          )}
        >
          <ErrorBoundary>
            {messageId ? (
              <InboxDetailDrawer
                headerSource={headerSource}
                detail={detail.data}
                detailLoading={detail.isLoading}
                detailNotFound={isMessageNotFound(detail.error)}
                detailError={detail.isError}
                reduceMotion={reduceMotion ?? false}
                view={inboxView}
                busy={itemAction.isPending || markUnread.isPending}
                onClose={() => navigate(inboxPath(inboxView, kindFilter))}
                onMarkUnread={() => {
                  if (!messageId) return;
                  setInboxActionError(null);
                  markUnread
                    .mutateAsync(messageId)
                    .catch(reportInboxActionError);
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
            ) : null}
          </ErrorBoundary>
        </section>
      </div>
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
  if (taskLookup.isError) {
    return "Couldn't load that task.";
  }
  return "That task is no longer in your feed.";
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
    <div className="py-0 pb-5">
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
