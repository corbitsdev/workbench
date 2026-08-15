// Inbox triage over the mailbox-backed product inbox routes. Col2 (shell
// panel) owns filters with counts; the stage is a TriagePane list|detail.
// Approve/deny for action items via native approval routes; mark-all-read /
// clear-done / done / snooze. Zero-item master-detail stays honest.

import {
  Badge,
  Button,
  EmptyState,
  Skeleton,
  TriageListItem,
  TriagePane,
} from "@corbits/react-ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { APIQuery } from "@corbits/api-query";
import {
  describeApiError,
  QueryView,
  SignedOutNotice,
} from "@corbits/api-query";
import { listTenantInvitableDefinitions } from "@corbits/chat-ui";
import {
  createMyraAgentSelectionStrategy,
  createTask,
  dispatchPlanner,
  getTask,
  listCatalogModels,
  MYRA_AUTO_SELECTION_ID,
  TaskComposerDialog,
} from "@corbits/tasks-ui";
import type { Task } from "@corbits/tasks-ui";

import { approveApproval, rejectApproval, useAPIQuery } from "../api";
import { useBench } from "../bench-context";
import { channelPath } from "../channel-path";
import {
  consumePendingNewTask,
  NEW_TASK_EVENT,
  requestMakeRoutine,
} from "../command-palette-actions";
import {
  listWorkflowDefinitions,
  suggestRoutineNameFromPrompt,
} from "../routines-api";
import { RECURRING_TASK_ASSET_NAME } from "@corbits/workflow-catalog";
import {
  loadMostRecentTaskAgent,
  saveMostRecentTaskAgent,
} from "../task-mru-agent";
import { libraryArtifactPath } from "@corbits/artifact-ui";
import {
  InboxCountsSchema,
  InboxItemDetailSchema,
  InboxListSchema,
  approvalIdFromItem,
  artifactRefsFromItem,
  channelRefFromItem,
  clearDoneInbox,
  inboxCountsPath,
  inboxDetailPath,
  inboxListPath,
  markAllInboxRead,
  markInboxItemDone,
  runRefFromItem,
  snoozeInboxItem,
  taskRefFromItem,
  type InboxCounts,
  type InboxFilterGroup,
  type InboxItem,
  type InboxItemDetail,
} from "../inbox-api";
import { inboxFilterFromPath } from "../shell/panel-contributions";
import { StageTopBar } from "../shell/stage-top-bar";

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function InboxList({
  items,
  selectedId,
  onSelect,
}: {
  readonly items: readonly InboxItem[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Inbox />}
        title="All caught up"
        description="Nothing open in this filter."
      />
    );
  }
  return (
    <div aria-label="Inbox items">
      {items.map((item) => (
        <TriageListItem
          key={item.id}
          selected={item.id === selectedId}
          onSelect={() => onSelect(item.id)}
          {...(item.read ? {} : { className: "font-medium" })}
        >
          <span className="truncate text-sm">
            {item.fromDisplay ?? item.from}
          </span>
          <span className="truncate text-sm text-muted-foreground">
            {item.subject ?? item.snippet ?? "Untitled"}
          </span>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge tone="neutral">{item.group}</Badge>
            <time dateTime={item.date}>{formatWhen(item.date)}</time>
          </span>
        </TriageListItem>
      ))}
    </div>
  );
}

function FactsGrid({ item }: { readonly item: InboxItemDetail }) {
  const rows: { label: string; value: string }[] = [
    { label: "From", value: item.fromDisplay ?? item.from },
    { label: "When", value: formatWhen(item.date) },
    { label: "Group", value: item.group },
    { label: "Status", value: item.status },
  ];
  if (item.priority !== undefined) {
    rows.push({ label: "Priority", value: item.priority });
  }
  if (item.assignee !== undefined) {
    rows.push({ label: "Assignee", value: item.assignee });
  }
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
      {rows.map((row) => (
        <div key={row.label}>
          <dt className="text-xs text-muted-foreground">{row.label}</dt>
          <dd className="font-medium">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function InboxDetail({
  tenantId,
  detail,
  busy,
  actionError,
  onApprove,
  onDeny,
  onDone,
  onSnooze,
  onOpenRun,
  onOpenChannel,
  onOpenArtifact,
  recurringTaskDefinitionId,
  onMakeRoutine,
}: {
  readonly tenantId: string | null;
  readonly detail: APIQuery<InboxItemDetail>;
  readonly busy: boolean;
  readonly actionError: string | null;
  readonly onApprove: (approvalId: string) => void;
  readonly onDeny: (approvalId: string) => void;
  readonly onDone: (id: string) => void;
  readonly onSnooze: (id: string) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenChannel: (channelId: string) => void;
  readonly onOpenArtifact: (artifactId: string) => void;
  /** The tenant's deployed "recurring-task" bridge workflow id (see
   * routine-launcher.ts), or null while it's still loading / genuinely
   * absent. "Make this a routine" needs this to resolve before it can
   * hand the create dialog a definitionId that actually lands in the
   * Routines picker — a task's own agent never does (conversational
   * definitions are never automatable). */
  readonly recurringTaskDefinitionId: string | null;
  readonly onMakeRoutine: (task: Task) => void;
}) {
  // A task-result item's own ref never carries the task's prompt or
  // status (see packages/notify's render.ts) — only its id, so "Make this
  // a routine" resolves the full record before it can gate on
  // `status === "done"`.
  const taskRef = detail.kind === "ready" ? taskRefFromItem(detail.data) : null;
  const taskQuery = useQuery({
    queryKey: ["task-for-inbox-item", tenantId, taskRef?.id ?? null],
    enabled: tenantId !== null && taskRef !== null,
    queryFn: () => getTask(tenantId ?? "", taskRef?.id ?? ""),
  });
  const task = taskQuery.data ?? null;

  if (detail.kind === "loading") {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (detail.kind === "error") {
    return (
      <EmptyState
        title="Couldn't load this item"
        description={describeApiError(
          { status: detail.status },
          "loading this item",
        )}
      />
    );
  }
  if (detail.kind === "unauthenticated") {
    return <SignedOutNotice />;
  }

  const item = detail.data;
  const approvalId = approvalIdFromItem(item);
  const run = runRefFromItem(item);
  const channel = channelRefFromItem(item);
  // `MyraChoiceSummary` ("why this agent?") needs a `plannerRunId` on
  // the inbox item, which `InboxItemDetail` doesn't carry today — no
  // backend surface threads it through yet. CL-6051 follow-up.
  const artifacts = artifactRefsFromItem(item);

  return (
    <article
      className="flex h-full flex-col gap-4 p-4"
      aria-label="Inbox item detail"
    >
      <header>
        <h2 className="m-0 text-base font-semibold">
          {item.subject ?? item.snippet ?? "Untitled"}
        </h2>
        <p className="m-0 mt-1 text-sm text-muted-foreground">
          {item.fromDisplay ?? item.from}
        </p>
      </header>
      <FactsGrid item={item} />
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-card p-3">
        <pre className="m-0 whitespace-pre-wrap font-sans text-sm leading-relaxed">
          {item.body}
        </pre>
      </div>
      {artifacts.length > 0 && (
        <div
          className="flex flex-wrap gap-2"
          data-testid="inbox-artifact-chips"
          aria-label="Artifacts"
        >
          {artifacts.map((artifact) => (
            <Button
              key={artifact.id}
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onOpenArtifact(artifact.id)}
            >
              {artifact.label ?? "Open in Library"}
            </Button>
          ))}
        </div>
      )}
      {actionError !== null && (
        <p className="m-0 text-sm text-destructive" role="alert">
          {actionError}
        </p>
      )}
      <footer className="flex flex-wrap gap-2">
        {approvalId !== null && (
          <>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => onApprove(approvalId)}
            >
              Approve
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => onDeny(approvalId)}
            >
              Deny
            </Button>
          </>
        )}
        {run !== null && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => onOpenRun(run.id)}
          >
            View run trace
          </Button>
        )}
        {task !== null &&
          task.status === "done" &&
          recurringTaskDefinitionId !== null && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => onMakeRoutine(task)}
            >
              Make this a routine
            </Button>
          )}
        {channel !== null && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => onOpenChannel(channel.id)}
          >
            Open conversation
          </Button>
        )}
        {item.group === "action" ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => onSnooze(item.id)}
          >
            Snooze 1h
          </Button>
        ) : (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => onDone(item.id)}
          >
            Done
          </Button>
        )}
        {item.group === "action" && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => onDone(item.id)}
          >
            Done
          </Button>
        )}
      </footer>
    </article>
  );
}

export function InboxPage({
  path,
  navigate,
}: {
  readonly path: string;
  readonly navigate: (to: string) => void;
}) {
  const { selectedTenantId } = useBench();
  const queryClient = useQueryClient();
  const group = inboxFilterFromPath(path) as InboxFilterGroup;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [taskSubmitting, setTaskSubmitting] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);

  useEffect(() => {
    if (consumePendingNewTask()) setTaskDialogOpen(true);
    const onEvent = () => setTaskDialogOpen(true);
    window.addEventListener(NEW_TASK_EVENT, onEvent);
    return () => window.removeEventListener(NEW_TASK_EVENT, onEvent);
  }, []);

  const countsQuery = useAPIQuery(
    selectedTenantId === null ? "" : inboxCountsPath(selectedTenantId),
    InboxCountsSchema,
  );
  const listQuery = useAPIQuery(
    selectedTenantId === null ? "" : inboxListPath(selectedTenantId, group),
    InboxListSchema,
  );

  // "Make this a routine" needs the tenant's deployed recurring-task
  // bridge workflow id (see apps/hub/src/routine-launcher.ts) — a
  // task's own agent is conversational and never resolves in the
  // Routines picker itself.
  const workflowDefinitionsQuery = useQuery({
    queryKey: ["workflow-definitions-for-inbox", selectedTenantId],
    enabled: selectedTenantId !== null,
    queryFn: () => listWorkflowDefinitions(selectedTenantId ?? ""),
  });
  const recurringTaskDefinitionId =
    workflowDefinitionsQuery.data?.find(
      (definition) => definition.assetName === RECURRING_TASK_ASSET_NAME,
    )?.id ?? null;

  const items = useMemo(() => {
    if (listQuery.kind !== "ready") return [] as InboxItem[];
    return listQuery.data.items;
  }, [listQuery]);

  useEffect(() => {
    setSelectedId(null);
  }, [group]);

  useEffect(() => {
    if (items.length === 0) {
      setSelectedId(null);
      return;
    }
    if (selectedId === null || !items.some((i) => i.id === selectedId)) {
      const first = items[0];
      if (first !== undefined) setSelectedId(first.id);
    }
  }, [items, selectedId]);

  const detailQuery = useAPIQuery(
    selectedTenantId === null || selectedId === null
      ? ""
      : inboxDetailPath(selectedTenantId, selectedId),
    InboxItemDetailSchema,
  );

  const counts: InboxCounts | null =
    countsQuery.kind === "ready" ? countsQuery.data : null;
  const needAction = counts?.action ?? null;
  const openCount = counts?.open ?? null;

  function invalidateInbox() {
    if (selectedTenantId === null) return;
    void queryClient.invalidateQueries({
      predicate: (q) => {
        const key = q.queryKey;
        if (!Array.isArray(key)) return false;
        return key.some(
          (part) =>
            typeof part === "string" &&
            part.includes(`/api/tenants/${selectedTenantId}/inbox`),
        );
      },
    });
  }

  function advanceAfter(id: string) {
    const idx = items.findIndex((i) => i.id === id);
    const next = items[idx + 1] ?? items[idx - 1] ?? null;
    setSelectedId(next?.id ?? null);
  }

  function runAction(fn: () => Promise<void>, advanceId?: string) {
    if (selectedTenantId === null) return;
    setBusy(true);
    setActionError(null);
    fn()
      .then(() => {
        if (advanceId !== undefined) advanceAfter(advanceId);
        invalidateInbox();
      })
      .catch(() => setActionError("That action didn't complete — try again."))
      .finally(() => setBusy(false));
  }

  function handleCreateTask(input: {
    readonly definitionId: string;
    readonly prompt: string;
    readonly modelPreference?: string;
  }) {
    if (selectedTenantId === null) return;
    setTaskSubmitting(true);
    setTaskError(null);
    // "Let Myra choose" (the sentinel `definitionId`) routes to the
    // planner instead of launching a real agent directly — Myra picks
    // or creates the agent and dispatches it herself. Only a real,
    // manually-picked `definitionId` is worth remembering as the MRU
    // agent; the sentinel would corrupt that convention.
    const dispatch =
      input.definitionId === MYRA_AUTO_SELECTION_ID
        ? dispatchPlanner(selectedTenantId, { outcome: input.prompt })
        : createTask(selectedTenantId, input).then(() => {
            saveMostRecentTaskAgent(selectedTenantId, input.definitionId);
          });
    dispatch
      .then(() => {
        setTaskDialogOpen(false);
      })
      .catch((cause: unknown) => {
        setTaskError(describeApiError(cause, "starting that task"));
      })
      .finally(() => setTaskSubmitting(false));
  }

  // A stable strategy reference across renders — recreating it every
  // render would remount the strategy component on every parent
  // re-render, refetching the agent list mid-composer. Wired to
  // `createMyraAgentSelectionStrategy` (CL-6051): "Let Myra choose" is
  // the default, one click away from the same manual list the prior
  // strategy rendered — `TaskComposerDialog` needs no change either
  // way, per `AgentSelectionStrategy`'s own "no default, no fallback"
  // contract.
  const taskAgentSelectionStrategy = useMemo(
    () => createMyraAgentSelectionStrategy(listTenantInvitableDefinitions),
    [],
  );

  if (selectedTenantId === null || listQuery.kind === "unauthenticated") {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <SignedOutNotice />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TaskComposerDialog
        open={taskDialogOpen}
        onOpenChange={(next) => {
          setTaskDialogOpen(next);
          // A failed attempt's message must not greet the next open —
          // the error belongs to the attempt, not to the dialog.
          if (!next) setTaskError(null);
        }}
        onCreate={handleCreateTask}
        tenantId={selectedTenantId}
        submitting={taskSubmitting}
        error={taskError}
        agentSelectionStrategy={taskAgentSelectionStrategy}
        listModels={listCatalogModels}
        initialDefinitionId={loadMostRecentTaskAgent(selectedTenantId)}
      />
      <StageTopBar
        title="Inbox"
        subtitle={
          needAction === null || openCount === null
            ? "Loading inbox…"
            : `${needAction} need action · ${openCount} open`
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setTaskDialogOpen(true)}
            >
              New task
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() =>
                runAction(() => markAllInboxRead(selectedTenantId))
              }
            >
              Mark all read
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => runAction(() => clearDoneInbox(selectedTenantId))}
            >
              Clear done
            </Button>
          </>
        }
      />
      <TriagePane
        className="min-h-0 flex-1 border-t-0"
        list={
          <QueryView query={listQuery} label="your inbox" skeleton="rows">
            {(page) => (
              <InboxList
                items={page.items}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            )}
          </QueryView>
        }
        detail={
          selectedId === null ? null : (
            <InboxDetail
              tenantId={selectedTenantId}
              detail={detailQuery}
              busy={busy}
              actionError={actionError}
              onApprove={(approvalId) => {
                const itemId = selectedId;
                if (itemId === null) return;
                runAction(
                  () =>
                    approveApproval(selectedTenantId, approvalId).then(() =>
                      markInboxItemDone(selectedTenantId, itemId),
                    ),
                  itemId,
                );
              }}
              onDeny={(approvalId) => {
                const itemId = selectedId;
                if (itemId === null) return;
                runAction(
                  () =>
                    rejectApproval(selectedTenantId, approvalId).then(() =>
                      markInboxItemDone(selectedTenantId, itemId),
                    ),
                  itemId,
                );
              }}
              onDone={(id) =>
                runAction(() => markInboxItemDone(selectedTenantId, id), id)
              }
              onSnooze={(id) =>
                runAction(() => snoozeInboxItem(selectedTenantId, id), id)
              }
              onOpenRun={(runId) => {
                navigate(`/insights/runs/${encodeURIComponent(runId)}`);
              }}
              onOpenChannel={(channelId) => {
                navigate(channelPath(channelId));
              }}
              onOpenArtifact={(artifactId) => {
                navigate(libraryArtifactPath(artifactId));
              }}
              recurringTaskDefinitionId={recurringTaskDefinitionId}
              onMakeRoutine={(task) => {
                // Never the task's own definitionId: a task's agent is
                // conversational, so it can never resolve in the Routines
                // picker (automatable-only) — the recurring-task bridge
                // workflow is the one definitionId that both schedules
                // and, on fire, dispatches this exact agent+prompt as a
                // task (see apps/hub/src/routine-launcher.ts). The button
                // itself only renders once recurringTaskDefinitionId has
                // resolved, so this is never null here.
                if (recurringTaskDefinitionId === null) return;
                requestMakeRoutine({
                  // This callback only ever fires from the Inbox page, so
                  // the hop to Routines is always off-route.
                  alreadyOnRoutines: false,
                  navigateToRoutines: () => navigate("/routines"),
                  prefill: {
                    definitionId: recurringTaskDefinitionId,
                    name: suggestRoutineNameFromPrompt(task.prompt),
                    input: { agent: task.definitionId, prompt: task.prompt },
                  },
                });
              }}
            />
          )
        }
        empty={
          <div className="flex h-full items-center justify-center p-6">
            <EmptyState
              icon={<Inbox />}
              title="Select an item"
              description={
                items.length === 0
                  ? "Nothing open right now."
                  : "Choose a message to read its full context."
              }
            />
          </div>
        }
      />
    </div>
  );
}

export function InboxRoute({
  path,
  navigate,
}: {
  readonly path: string;
  readonly navigate: (to: string) => void;
}) {
  return <InboxPage path={path} navigate={navigate} />;
}
