// A real workbench as the playground's data source: the bench, its roster
// and its mailbox, read and sent over the same stock routes the live chat
// uses. The components never see where data came from.

import { reportError } from "@corbits/error-sink";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { type } from "arktype";
import { useCallback, useEffect, useMemo, useState } from "react";

import { listTopLevelRuns } from "@/agents-api";
import { TenantApprovalsSchema, apiQueryOptions, approveApproval, rejectApproval } from "@/api";
import { nameWorkers, useWorkerNames } from "@/bench/worker-name";
import {
  listWorkbenchParticipants,
  readWorkbenchPage,
  sameAddress,
  sendToWorkbench,
  subscribeToInbox,
  workbenchMessages,
  type WorkbenchFolder,
} from "@/chat/threads-api";
import { workbenchKeys } from "@/chat-path";
import { createFetchStockHub } from "@/needs-converge";
import { pendingApprovalsPath } from "@/pending-approvals";
import { tenantKeys } from "@/query-client";

import {
  LIVE_ME_ID,
  liveApprovals,
  liveConversation,
  mergeFolders,
  unsettledSends,
  workerActivity,
  type PendingSend,
  type RuntimeStatus,
  type WorkerActivity,
} from "./live-adapter";
import type { ApprovalDecision, ChatMessage, Participant, TimelineEntry } from "./model";

/** How long after your send the chat shows the agent working, at most, when
 * no reply arrives. */
const WAITING_CAP_MS = 10 * 60_000;

/** How often the worker's run is asked what it's doing: quickly while a
 * turn is open, otherwise only to notice other people's turns. */
const STATUS_ACTIVE_MS = 2_000;
const STATUS_IDLE_MS = 10_000;

const RunStatus = type({ "runtimeStatus?": "'idle' | 'busy' | 'waiting_approval'" });

/** The run's own account of its turn, or null when the hub has none (its
 * collector starts with the run's first activity). */
async function readRuntimeStatus(benchId: string, runId: string): Promise<RuntimeStatus | null> {
  const response = await fetch(
    `/api/tenants/${encodeURIComponent(benchId)}/workflows/runs/${encodeURIComponent(runId)}`,
    { headers: { accept: "application/json" } },
  );
  if (!response.ok) throw new Error(`The run answered ${String(response.status)}.`);
  const parsed = RunStatus(await response.json());
  if (parsed instanceof type.errors) throw new Error(`Unexpected run shape: ${parsed.summary}`);
  return parsed.runtimeStatus ?? null;
}

export type LiveWorkbench = {
  /** False without `?bench=`: the playground stays on its fixtures. */
  readonly enabled: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly benchName: string | null;
  readonly entries: readonly TimelineEntry[];
  readonly participants: readonly Participant[];
  /** Agents that can be messaged now: those with a live run. */
  readonly agents: readonly Participant[];
  /** The worker's state: from its run where the hub reports one, else
   * from whether your last message has been answered. */
  readonly activity: WorkerActivity;
  /** Sends `text`; with `replyTo`, as a reply to that message. */
  readonly send: (text: string, replyTo?: string) => void;
  /** Older messages exist beyond what has been read so far. */
  readonly hasEarlier: boolean;
  /** Reads the next page back; a no-op while one is already on its way. */
  readonly loadEarlier: () => void;
  /** Answers a pending approval. The routes know two scopes: "always"
   * holds for the rest of this run, and "ask every time" is the same as
   * allowing once. */
  readonly decide: (approvalId: string, decision: ApprovalDecision) => void;
};

type Pending = PendingSend & { readonly failed: boolean };

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function pendingEntry(send: Pending): ChatMessage {
  return {
    type: "message",
    id: send.id,
    authorId: LIVE_ME_ID,
    at: send.at,
    parts: [{ type: "text", text: send.text }],
    status: send.failed ? "failed" : "sending",
    ...(send.threadId === undefined ? {} : { threadId: send.threadId }),
  };
}

export function useLiveWorkbench(
  benchId: string | undefined,
  /** Messages read per folder per page; the mailbox allows up to 200. */
  pageSize: number,
): LiveWorkbench {
  const enabled = benchId !== undefined;
  const id = benchId ?? "";
  const queryClient = useQueryClient();

  const tenant = useQuery({
    queryKey: workbenchKeys.tenant(id),
    queryFn: () => createFetchStockHub().getTenant(id),
    enabled,
  });
  const roster = useQuery({
    queryKey: workbenchKeys.participants(id),
    queryFn: () => listWorkbenchParticipants(id, tenant.data?.domain ?? ""),
    // A person's mailbox address depends on the bench's domain.
    enabled: enabled && tenant.data !== undefined && tenant.data !== null,
  });
  // Each folder pages back on its own; `mergeFolders` keeps the two in step.
  const folderQuery = (folder: WorkbenchFolder) => ({
    queryKey: [...workbenchKeys.scope(id), "folder", folder, pageSize],
    queryFn: ({ pageParam }: { readonly pageParam: string }) =>
      readWorkbenchPage(id, folder, {
        limit: pageSize,
        ...(pageParam === "" ? {} : { cursor: pageParam }),
      }),
    // The newest page has no cursor.
    initialPageParam: "",
    getNextPageParam: (page: { readonly nextCursor: string | undefined }) => page.nextCursor,
    enabled,
  });
  const inbox = useInfiniteQuery(folderQuery("INBOX"));
  const sent = useInfiniteQuery(folderQuery("Sent"));
  const history = useMemo(
    () =>
      mergeFolders(
        {
          turns: inbox.data?.pages.flatMap((page) => page.turns) ?? [],
          complete: !inbox.hasNextPage,
        },
        {
          turns: sent.data?.pages.flatMap((page) => page.turns) ?? [],
          complete: !sent.hasNextPage,
        },
      ),
    [inbox.data, inbox.hasNextPage, sent.data, sent.hasNextPage],
  );
  const messages = useMemo(() => workbenchMessages(history.turns), [history.turns]);
  const { fetchNextPage: fetchInbox, isFetchingNextPage: fetchingInbox } = inbox;
  const { fetchNextPage: fetchSent, isFetchingNextPage: fetchingSent } = sent;
  const loadEarlier = useCallback(() => {
    if (fetchingInbox || fetchingSent) return;
    if (history.behind === "INBOX") void fetchInbox();
    if (history.behind === "Sent") void fetchSent();
  }, [history.behind, fetchInbox, fetchSent, fetchingInbox, fetchingSent]);
  // A list hook, so a playground without a bench asks for nothing.
  const workerNames = useWorkerNames(enabled ? [id] : []);

  // The stream says only that something changed, so everything is re-read.
  useEffect(() => {
    if (!enabled) return undefined;
    return subscribeToInbox(id, () => {
      void queryClient.invalidateQueries({ queryKey: workbenchKeys.scope(id) });
      // A parked ask sends no mail but still ticks the stream.
      void queryClient.invalidateQueries({ queryKey: tenantKeys.pendingApprovals(id) });
    });
  }, [enabled, id, queryClient]);

  const workerName = workerNames.get(id);
  const named = useMemo(
    () => nameWorkers(roster.data ?? [], workerName),
    [roster.data, workerName],
  );
  const worker = named.find(
    (participant) => participant.kind === "agent" && participant.address.includes("@"),
  );
  const runs = useQuery({
    queryKey: [...workbenchKeys.scope(id), "runs"],
    queryFn: () => listTopLevelRuns(id),
    enabled: enabled && worker !== undefined,
  });
  const runId =
    worker === undefined
      ? undefined
      : runs.data?.find((run) => sameAddress(run.address, worker.address))?.id;

  const conversation = useMemo(() => liveConversation(messages, named), [messages, named]);

  const [pending, setPending] = useState<readonly Pending[]>([]);
  // Sends drop out once the mailbox echoes them back.
  const waitingOn = unsettledSends(conversation.entries, pending);
  const unsettled = pending.filter((send) => waitingOn.some((open) => open.id === send.id));

  const send = useCallback(
    (text: string, replyTo?: string) => {
      const at = new Date().toISOString();
      const sendId = `pending-${at}`;
      setPending((current) => [
        ...current,
        {
          id: sendId,
          text,
          at,
          failed: false,
          ...(replyTo === undefined ? {} : { threadId: replyTo }),
        },
      ]);
      const parent =
        replyTo === undefined ? undefined : messages.find((message) => message.id === replyTo);
      sendToWorkbench({
        workbenchTenantId: id,
        participants: named,
        content: text,
        ...(parent === undefined ? {} : { inReplyTo: parent.messageId }),
      })
        .then(() => queryClient.invalidateQueries({ queryKey: workbenchKeys.scope(id) }))
        .catch((cause: unknown) => {
          reportError(cause, { operation: "chat_prototype_live_send" });
          setPending((current) =>
            current.map((item) => (item.id === sendId ? { ...item, failed: true } : item)),
          );
        });
    },
    [id, named, queryClient, messages],
  );

  // Messages only: what "waiting on a reply" is worked out from.
  const messageEntries = useMemo(
    () => [...conversation.entries, ...unsettled.map(pendingEntry)],
    [conversation.entries, unsettled],
  );
  const agentIds = new Set(
    named.filter((participant) => participant.kind === "agent").map((agent) => agent.id),
  );
  const lastAt = (match: (entry: ChatMessage) => boolean) =>
    Math.max(
      0,
      ...messageEntries.flatMap((entry) =>
        entry.type === "message" && match(entry) ? [Date.parse(entry.at)] : [],
      ),
    );
  const lastOwn = lastAt((entry) => entry.authorId === LIVE_ME_ID && entry.threadId === undefined);
  const lastAgent = lastAt((entry) => agentIds.has(entry.authorId));
  const waitingOnReply = lastOwn > lastAgent && Date.now() - lastOwn < WAITING_CAP_MS;

  const status = useQuery({
    queryKey: [...workbenchKeys.scope(id), "run-status", runId ?? ""],
    queryFn: () => readRuntimeStatus(id, runId ?? ""),
    enabled: enabled && runId !== undefined,
    refetchInterval: (query) =>
      waitingOnReply || (query.state.data !== null && query.state.data !== "idle")
        ? STATUS_ACTIVE_MS
        : STATUS_IDLE_MS,
  });
  const approvals = useQuery({
    ...apiQueryOptions(pendingApprovalsPath(id), TenantApprovalsSchema),
    enabled,
    // The run says when it's parked on one; until it lands, keep asking.
    refetchInterval: status.data === "waiting_approval" ? STATUS_ACTIVE_MS : false,
  });
  // Decided here: kept on screen with the choice made, since the decided
  // approval drops out of the pending list.
  const [decided, setDecided] = useState<ReadonlyMap<string, ChatMessage>>(() => new Map());
  const pendingCards = useMemo(
    () => liveApprovals(approvals.data?.data ?? [], named),
    [approvals.data, named],
  );
  const decide = useCallback(
    (approvalId: string, decision: ApprovalDecision) => {
      const card = pendingCards.find((entry) =>
        entry.parts.some((part) => part.type === "approval" && part.id === approvalId),
      );
      if (card === undefined) return;
      const answered: ChatMessage = {
        ...card,
        parts: card.parts.map((part) =>
          part.type === "approval" && part.id === approvalId ? { ...part, decision } : part,
        ),
      };
      setDecided((current) => new Map(current).set(approvalId, answered));
      const request =
        decision === "deny"
          ? rejectApproval(id, approvalId)
          : approveApproval(id, approvalId, decision === "always" ? "always" : "once");
      request
        .then(() => queryClient.invalidateQueries({ queryKey: tenantKeys.pendingApprovals(id) }))
        .catch((cause: unknown) => {
          reportError(cause, { operation: "chat_prototype_live_decide" });
          // Back to undecided, so the person can try again.
          setDecided((current) => {
            const next = new Map(current);
            next.delete(approvalId);
            return next;
          });
        });
    },
    [id, pendingCards, queryClient],
  );

  const entries = useMemo(() => {
    const cards = [
      ...pendingCards.filter((card) => !decided.has(card.id.replace(/^approval:/, ""))),
      ...decided.values(),
    ];
    // Cards go where they were raised; the timeline is otherwise in order.
    const timed = [...conversation.entries, ...cards].sort(
      (a, b) => Date.parse(a.at) - Date.parse(b.at),
    );
    return [...timed, ...unsettled.map(pendingEntry)];
  }, [conversation.entries, pendingCards, decided, unsettled]);

  // When the run was last seen taking a turn, so an idle reading after a
  // send can tell "not started yet" from "finished".
  const [activeAt, setActiveAt] = useState<number | null>(null);
  const runtimeStatus = status.data ?? undefined;
  useEffect(() => {
    if (runtimeStatus === "busy" || runtimeStatus === "waiting_approval") setActiveAt(Date.now());
  }, [runtimeStatus, status.dataUpdatedAt]);

  const failure = tenant.error ?? roster.error ?? inbox.error ?? sent.error;
  const missing = tenant.data === null;
  return {
    enabled,
    // Until the roster is in, senders would show as raw run addresses.
    loading:
      enabled &&
      !missing &&
      (tenant.isPending || roster.isPending || inbox.isPending || sent.isPending),
    error:
      failure !== null
        ? errorText(failure)
        : missing
          ? "There's no workbench with that id, or you can't open it."
          : null,
    benchName: tenant.data?.name ?? null,
    entries,
    participants: conversation.participants,
    agents: conversation.participants.filter(
      (participant) =>
        participant.kind === "agent" &&
        named.some((member) => member.id === participant.id && member.address.includes("@")),
    ),
    activity: workerActivity({
      runtimeStatus,
      waitingOnReply,
      busySinceSend: activeAt !== null && activeAt >= lastOwn,
    }),
    send,
    decide,
    hasEarlier: history.hasEarlier,
    loadEarlier,
  };
}
