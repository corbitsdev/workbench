// A real workbench as the playground's data source: the bench, its roster
// and its mailbox, read and sent over the same stock routes the live chat
// uses. The components never see where data came from.

import { reportError } from "@corbits/error-sink";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { nameWorkers, useWorkerNames } from "@/bench/worker-name";
import {
  listWorkbenchParticipants,
  readWorkbench,
  sendToWorkbench,
  subscribeToInbox,
} from "@/chat/threads-api";
import { workbenchKeys } from "@/chat-path";
import { createFetchStockHub } from "@/needs-converge";

import { LIVE_ME_ID, liveConversation, unsettledSends, type PendingSend } from "./live-adapter";
import type { ChatMessage, Participant, TimelineEntry } from "./model";

/** How long after your send the chat shows the agent working, at most, when
 * no reply arrives. */
const WAITING_CAP_MS = 10 * 60_000;

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
  /** You've sent, and no agent has answered since. */
  readonly waiting: boolean;
  /** Sends `text`; with `replyTo`, as a reply to that message. */
  readonly send: (text: string, replyTo?: string) => void;
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

export function useLiveWorkbench(benchId: string | undefined): LiveWorkbench {
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
  const timeline = useQuery({
    queryKey: workbenchKeys.timeline(id),
    queryFn: () => readWorkbench(id),
    enabled,
  });
  // A list hook, so a playground without a bench asks for nothing.
  const workerNames = useWorkerNames(enabled ? [id] : []);

  // The stream says only that something changed, so everything is re-read.
  useEffect(() => {
    if (!enabled) return undefined;
    return subscribeToInbox(id, () => {
      void queryClient.invalidateQueries({ queryKey: workbenchKeys.scope(id) });
    });
  }, [enabled, id, queryClient]);

  const workerName = workerNames.get(id);
  const named = useMemo(
    () => nameWorkers(roster.data ?? [], workerName),
    [roster.data, workerName],
  );
  const conversation = useMemo(
    () => liveConversation(timeline.data ?? [], named),
    [timeline.data, named],
  );

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
        replyTo === undefined
          ? undefined
          : (timeline.data ?? []).find((message) => message.id === replyTo);
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
    [id, named, queryClient, timeline.data],
  );

  const entries = useMemo(
    () => [...conversation.entries, ...unsettled.map(pendingEntry)],
    [conversation.entries, unsettled],
  );
  const agentIds = new Set(
    named.filter((participant) => participant.kind === "agent").map((agent) => agent.id),
  );
  const lastAt = (match: (entry: ChatMessage) => boolean) =>
    Math.max(
      0,
      ...entries.flatMap((entry) =>
        entry.type === "message" && match(entry) ? [Date.parse(entry.at)] : [],
      ),
    );
  const lastOwn = lastAt((entry) => entry.authorId === LIVE_ME_ID && entry.threadId === undefined);
  const lastAgent = lastAt((entry) => agentIds.has(entry.authorId));

  const failure = tenant.error ?? roster.error ?? timeline.error;
  const missing = tenant.data === null;
  return {
    enabled,
    // Until the roster is in, senders would show as raw run addresses.
    loading: enabled && !missing && (tenant.isPending || roster.isPending || timeline.isPending),
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
    waiting: lastOwn > lastAgent && Date.now() - lastOwn < WAITING_CAP_MS,
    send,
  };
}
