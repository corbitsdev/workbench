// A workbench is a child tenant, and its room is that tenant's mailbox:
// the timeline is the tenant's mail threads, participants are its
// principals, and a message is addressed to every agent in the room. The
// left info column folds in what Mission Control used to show for a
// bench overall — here scoped to this one workbench: latest activity,
// relevant artifacts, and pending approvals with approve/deny. Sub-threads
// are native in-reply-to chains, shown in a side panel.

import {
  Button,
  EmptyState,
  PageShell,
  Skeleton,
  formatRelativeTime,
  toast,
} from "@corbits/react-ui";
import { WarningCircle } from "@/lib/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { ApprovalRow } from "@/chat/approval-row";
import { IdentityAvatar } from "@/chat/avatar";
import { Composer } from "@/chat/composer";
import { Markdown } from "@/chat/markdown";
import {
  ancestorChain,
  listRoomParticipants,
  readRoom,
  resolveParticipantName,
  sendToRoom,
  subscribeToInbox,
  type RoomMessage,
  type RoomParticipant,
} from "@/chat/threads-api";
import { ArtifactListPageSchema, useAPIQuery } from "../api";
import { useBench } from "../bench-context";
import { createFetchStockHub } from "../needs-converge";
import { usePendingApprovals } from "../pending-approvals";
import { roomKeys } from "../chat-path";
import { StageTopBar } from "../shell/stage-top-bar";
import { redeployRoomAgent } from "../workbench-create";
import { workbenchIdFromPath } from "../workbench-path";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function RoomMessageRow({
  message,
  participants,
  onReply,
}: {
  readonly message: RoomMessage;
  readonly participants: readonly RoomParticipant[];
  /** Undefined in the sub-thread panel, where a row is read-only context. */
  readonly onReply?: (message: RoomMessage) => void;
}) {
  // Avatars read off the participant's display name (Myra → "M"), never the
  // run address local part a mail turn otherwise carries.
  const displayName = resolveParticipantName(message, participants);
  const matched = participants.find((participant) => participant.address === message.address);
  const kind = message.author !== "me" && matched?.kind === "agent" ? "agent" : "person";
  return (
    <div className="chat-thread-message" data-author={message.author}>
      <span className="shell-ch-avatar">
        <IdentityAvatar
          kind={kind}
          name={displayName}
          principalId={matched?.id ?? message.address}
        />
      </span>
      <div className="chat-thread-body">
        <Markdown text={message.body} />
        {onReply === undefined ? null : (
          <button type="button" className="room-replies-link" onClick={() => onReply(message)}>
            Reply
          </button>
        )}
      </div>
    </div>
  );
}

function ParticipantList({ participants }: { readonly participants: readonly RoomParticipant[] }) {
  return (
    <ul className="room-participants" aria-label="In this workbench">
      {participants.map((participant) => (
        <li key={participant.id} data-kind={participant.kind}>
          <span className="shell-ch-avatar">
            <IdentityAvatar
              kind={participant.kind}
              name={participant.name}
              principalId={participant.id}
            />
          </span>
          {participant.name}
        </li>
      ))}
    </ul>
  );
}

/** The left info column: what Mission Control used to show, scoped to this
 * one workbench — its latest activity, its relevant artifacts, and what's
 * pending on it — plus the participant roster already read for the room. */
function RoomInfoColumn({
  roomTenantId,
  latestMessage,
  participants,
}: {
  readonly roomTenantId: string;
  readonly latestMessage: RoomMessage | undefined;
  readonly participants: readonly RoomParticipant[];
}) {
  const anyAgentLive = participants.some((p) => p.kind === "agent" && p.address !== "");
  const approvalsQuery = usePendingApprovals(roomTenantId, {
    refetchInterval: anyAgentLive ? 3000 : false,
  });
  const artifactsQuery = useAPIQuery(
    `/api/tenants/${roomTenantId}/artifacts`,
    ArtifactListPageSchema,
  );
  const pendingApprovals = approvalsQuery.kind === "ready" ? approvalsQuery.data : null;

  return (
    <aside className="room-info-column" aria-label="Workbench details">
      <section className="room-info-panel">
        <div className="room-info-panel-header">
          <h2>Latest activity</h2>
        </div>
        {latestMessage === undefined ? (
          <p className="room-info-empty-note">Nothing yet — say something to get started.</p>
        ) : (
          <p className="room-info-cell-context">
            {resolveParticipantName(latestMessage, participants)} ·{" "}
            {formatRelativeTime(latestMessage.at)}
          </p>
        )}
      </section>

      <section className="room-info-panel">
        <div className="room-info-panel-header">
          <h2>Approvals</h2>
        </div>
        {approvalsQuery.kind === "loading" ? <Skeleton className="h-16 w-full" /> : null}
        {approvalsQuery.kind === "error" ? (
          <p className="room-info-empty-note">{approvalsQuery.message}</p>
        ) : null}
        {pendingApprovals !== null && pendingApprovals.length === 0 ? (
          <p className="room-info-empty-note">Nothing waiting on you.</p>
        ) : null}
        {pendingApprovals !== null && pendingApprovals.length > 0 ? (
          <ul className="room-info-approval-list">
            {pendingApprovals.map((item) => (
              <ApprovalRow key={item.id} item={item} tenantId={roomTenantId} />
            ))}
          </ul>
        ) : null}
      </section>

      <section className="room-info-panel">
        <div className="room-info-panel-header">
          <h2>Artifacts</h2>
        </div>
        {artifactsQuery.kind === "loading" ? <Skeleton className="h-16 w-full" /> : null}
        {artifactsQuery.kind === "error" ? (
          <p className="room-info-empty-note">{artifactsQuery.message}</p>
        ) : null}
        {artifactsQuery.kind === "ready" && artifactsQuery.data.artifacts.length === 0 ? (
          <p className="room-info-empty-note">No artifacts yet.</p>
        ) : null}
        {artifactsQuery.kind === "ready" && artifactsQuery.data.artifacts.length > 0 ? (
          <ul className="room-info-artifact-list">
            {artifactsQuery.data.artifacts.slice(0, 5).map((artifact) => (
              <li key={artifact.id}>
                <span className="room-info-cell-primary">{artifact.title}</span>
                <br />
                <span className="room-info-cell-context">{artifact.kind}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="room-info-panel">
        <div className="room-info-panel-header">
          <h2>Participants</h2>
        </div>
        <ParticipantList participants={participants} />
      </section>
    </aside>
  );
}

/** Redeploys one released agent (asset present, no live run — a hub
 * restart releases every process-provisioned deployment). Renders nothing;
 * one instance per released agent, keyed by asset id, so a mount's own ref
 * plus the mutation's `isPending`/`isSuccess` keep StrictMode's double
 * render (and any refetch that finds the same agent still released) from
 * firing it twice. */
function AgentRedeployer({
  roomTenantId,
  agent,
}: {
  readonly roomTenantId: string;
  readonly agent: { readonly id: string; readonly name: string; readonly assetName: string };
}) {
  const queryClient = useQueryClient();
  const started = useRef(false);
  const redeploy = useMutation({
    mutationFn: () => redeployRoomAgent(roomTenantId, agent),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: roomKeys.scope(roomTenantId) }),
    onError: (cause) => toast(errorText(cause)),
  });
  if (!started.current && !redeploy.isPending && !redeploy.isSuccess) {
    started.current = true;
    redeploy.mutate();
  }
  return null;
}

function Room({ roomTenantId }: { readonly roomTenantId: string }) {
  const queryClient = useQueryClient();
  const [openThread, setOpenThread] = useState<string | null>(null);

  const tenant = useQuery({
    queryKey: roomKeys.tenant(roomTenantId),
    queryFn: () => createFetchStockHub().getTenant(roomTenantId),
  });
  const participants = useQuery({
    queryKey: roomKeys.participants(roomTenantId),
    queryFn: () => listRoomParticipants(roomTenantId),
    // Poll while any agent has no live run yet, so the room notices its own
    // redeploy finishing without a manual refresh.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((p) => p.kind === "agent" && p.address === "") ? 3000 : false,
  });
  const timeline = useQuery({
    queryKey: roomKeys.timeline(roomTenantId),
    queryFn: () => readRoom(roomTenantId),
  });

  // The room mailbox stream is the only signal that an agent answered; it
  // carries no thread identity, so it invalidates rather than patches.
  useEffect(
    () =>
      subscribeToInbox(roomTenantId, () => {
        void queryClient.invalidateQueries({ queryKey: roomKeys.scope(roomTenantId) });
      }),
    [roomTenantId, queryClient],
  );

  const agents = (participants.data ?? []).filter((participant) => participant.kind === "agent");
  // Released by a hub restart: the asset is still here but nothing is live.
  const releasedAgents = agents.filter(
    (agent): agent is RoomParticipant & { assetName: string } =>
      agent.address === "" && agent.assetName !== undefined,
  );
  const startingAgent = releasedAgents[0];
  const send = useMutation({
    mutationFn: ({
      content,
      inReplyTo,
    }: {
      readonly content: string;
      readonly inReplyTo?: string;
    }) =>
      sendToRoom({
        roomTenantId,
        agents,
        content,
        ...(inReplyTo !== undefined ? { inReplyTo } : {}),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: roomKeys.scope(roomTenantId) }),
  });

  const messages = timeline.data ?? [];
  const latestMessage = [...messages].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  const openedChain = openThread === null ? [] : ancestorChain(messages, openThread);
  const opened = openedChain.at(-1);
  const failure: unknown = timeline.error ?? participants.error;

  if (failure !== null && failure !== undefined && timeline.data === undefined) {
    return (
      <PageShell width="full" className="page-fill">
        <EmptyState
          icon={<WarningCircle />}
          title="Couldn't open this workbench"
          description={errorText(failure)}
        />
      </PageShell>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {releasedAgents.map((agent) => (
        <AgentRedeployer
          key={agent.id}
          roomTenantId={roomTenantId}
          agent={{ id: agent.id, name: agent.name, assetName: agent.assetName }}
        />
      ))}
      <StageTopBar crumbs={[{ label: tenant.data?.name ?? "Workbench" }]} />
      <div className="room-layout">
        <RoomInfoColumn
          roomTenantId={roomTenantId}
          latestMessage={latestMessage}
          participants={participants.data ?? []}
        />
        <div className="room-main">
          <div className="room-main-scroll">
            <PageShell width="prose" className="page-fill">
              <div className="chat-thread-messages">
                {messages.map((message) => (
                  <RoomMessageRow
                    key={message.id}
                    message={message}
                    participants={participants.data ?? []}
                    onReply={(target) => setOpenThread(target.messageId)}
                  />
                ))}
              </div>
              {send.error === null ? null : (
                <p className="chat-thread-error">{errorText(send.error)}</p>
              )}
            </PageShell>
          </div>
          <div className="room-main-composer">
            <PageShell width="prose" className="page-fill">
              <Composer
                placeholder={
                  startingAgent === undefined
                    ? "Message this workbench"
                    : `${startingAgent.name} is starting…`
                }
                busy={send.isPending}
                disabled={startingAgent !== undefined}
                onSend={(text) => send.mutate({ content: text })}
              />
            </PageShell>
          </div>
        </div>
        {opened === undefined ? null : (
          <aside className="room-subthread" aria-label="Replies">
            <div className="room-subthread-head">
              <h2>Replies</h2>
              <Button variant="ghost" size="sm" onClick={() => setOpenThread(null)}>
                Close
              </Button>
            </div>
            <div className="chat-thread-messages">
              {openedChain.map((message) => (
                <RoomMessageRow
                  key={message.id}
                  message={message}
                  participants={participants.data ?? []}
                />
              ))}
            </div>
            <Composer
              placeholder={
                startingAgent === undefined
                  ? "Reply in this thread"
                  : `${startingAgent.name} is starting…`
              }
              busy={send.isPending}
              disabled={startingAgent !== undefined}
              onSend={(text) => send.mutate({ content: text, inReplyTo: opened.messageId })}
            />
          </aside>
        )}
      </div>
    </div>
  );
}

export function WorkbenchRoomRoute({ path }: { readonly path: string }) {
  const { selectedTenantId } = useBench();
  const roomTenantId = workbenchIdFromPath(path);

  if (selectedTenantId === null || roomTenantId === null) {
    return (
      <PageShell width="full" className="page-fill">
        <EmptyState
          icon={<WarningCircle />}
          title="No workbench selected"
          description="Pick a workbench from the sidebar, or start a new one."
        />
      </PageShell>
    );
  }
  return <Room roomTenantId={roomTenantId} />;
}
