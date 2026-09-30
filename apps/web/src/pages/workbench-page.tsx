// See docs/chat-mail-threading.md. The bench pill opens a drawer that pushes
// the thread left; the drawer's Information tab carries the bench overview.

import { Button, EmptyState, PageShell, toast } from "@corbits/react-ui";
import { WarningCircle } from "@/lib/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { IdentityAvatar } from "@/chat/avatar";
import { Composer } from "@/chat/composer";
import { Markdown } from "@/chat/markdown";
import { MessageAttachments } from "@/chat/message-attachments";
import { resolveMessagePackage } from "@/chat/deployable-package";
import { stripRoster } from "@/chat/workbench-roster";
import {
  ancestorChain,
  listWorkbenchParticipants,
  readWorkbench,
  resolveAvatarName,
  sameAddress,
  sendToWorkbench,
  subscribeToInbox,
  type WorkbenchMessage,
  type WorkbenchParticipant,
} from "@/chat/threads-api";
import { VoiceOverlay } from "../voice/voice-overlay";
import { BenchDrawer } from "../bench/bench-drawer";
import { BenchPill } from "../bench/bench-pill";
import { PendingOpeningMessage } from "../bench/pending-opening-message";
import { ArtifactsTab } from "../bench/artifacts-tab";
import { markTurnPending, useWorkerStatus } from "../worker-status";
import { GrantsTab } from "../bench/grants-tab";
import { InformationTab } from "../bench/information-tab";
import { InsightsTab } from "../bench/insights-tab";
import { MembersTab } from "../bench/members-tab";
import { ToolsTab } from "../bench/tools-tab";
import { WorkflowsTab } from "../bench/workflows-tab";
import { useBench } from "../bench-context";
import { createFetchStockHub } from "../needs-converge";
import { workbenchKeys } from "../chat-path";
import { tenantKeys } from "../query-client";
import { recordLastWorkbenchId } from "../last-workbench";
import { redeployWorkbenchAgent } from "../workbench-create";
import { workbenchIdFromPath } from "../workbench-path";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function WorkbenchMessageRow({
  message,
  participants,
  workbenchTenantId,
  onReply,
}: {
  readonly message: WorkbenchMessage;
  readonly participants: readonly WorkbenchParticipant[];
  readonly workbenchTenantId: string;
  /** Undefined in the sub-thread panel, where a row is read-only context. */
  readonly onReply?: (message: WorkbenchMessage) => void;
}) {
  // Avatars read off the participant's real name — the person's own
  // included, never the "You" transcript label — falling back to the
  // address local part a mail turn otherwise carries.
  const avatarName = resolveAvatarName(message, participants);
  const matched = participants.find((participant) =>
    sameAddress(participant.address, message.address),
  );
  const kind = message.author !== "me" && matched?.kind === "agent" ? "agent" : "person";
  // The person's own send carries a trailing roster block so agents in the
  // workbench can hand off to each other; it's never something a person should
  // see echoed back at them.
  const body = message.author === "me" ? stripRoster(message.body) : message.body;
  const { pkg, renderedBody } = resolveMessagePackage(message.attachments, body);
  const own = message.author === "me";
  const time = new Date(message.at);
  const content = (
    <>
      <Markdown text={renderedBody} />
      <MessageAttachments
        tenantId={workbenchTenantId}
        attachments={message.attachments}
        pkg={pkg}
      />
    </>
  );
  const reply =
    onReply === undefined ? null : (
      <button type="button" className="workbench-replies-link" onClick={() => onReply(message)}>
        Reply
      </button>
    );
  if (own) {
    return (
      <div className="chat-thread-message" data-author="me">
        <div className="chat-thread-body">
          <div className="chat-thread-own-bubble">{content}</div>
          {reply}
        </div>
      </div>
    );
  }
  return (
    <div className="chat-thread-message" data-author={message.author}>
      <span className="shell-ch-avatar">
        <IdentityAvatar
          kind={kind}
          name={avatarName}
          principalId={matched?.id ?? message.address}
        />
      </span>
      <div className="chat-thread-body">
        <div className="chat-thread-head">
          <b>{avatarName}</b>
          {Number.isNaN(time.getTime()) ? null : (
            <time dateTime={message.at}>
              {time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </time>
          )}
        </div>
        {content}
        {reply}
      </div>
    </div>
  );
}

// Renders nothing; a mount's own ref plus the mutation's `isPending`/
// `isSuccess` keep StrictMode's double render from firing it twice.
function AgentRedeployer({
  workbenchTenantId,
  agent,
}: {
  readonly workbenchTenantId: string;
  readonly agent: {
    readonly id: string;
    readonly name: string;
    readonly assetName: string;
  };
}) {
  const queryClient = useQueryClient();
  const started = useRef(false);
  const redeploy = useMutation({
    mutationFn: () => redeployWorkbenchAgent(workbenchTenantId, agent),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: workbenchKeys.scope(workbenchTenantId),
      }),
    onError: (cause) => toast(errorText(cause)),
  });
  if (!started.current && !redeploy.isPending && !redeploy.isSuccess) {
    started.current = true;
    redeploy.mutate();
  }
  return null;
}

function Workbench({ workbenchTenantId }: { readonly workbenchTenantId: string }) {
  const queryClient = useQueryClient();
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const endVoice = useCallback(() => setVoiceOpen(false), []);

  const tenant = useQuery({
    queryKey: workbenchKeys.tenant(workbenchTenantId),
    queryFn: () => createFetchStockHub().getTenant(workbenchTenantId),
  });
  const participants = useQuery({
    queryKey: workbenchKeys.participants(workbenchTenantId),
    queryFn: () => listWorkbenchParticipants(workbenchTenantId, tenant.data?.domain ?? ""),
    // The workbench tenant's domain is read first; a person's mailbox address
    // depends on it, so participants wait for it rather than racing it.
    enabled: tenant.data !== undefined,
    // Poll while any agent has no live run yet, so the workbench notices its own
    // redeploy finishing without a manual refresh.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((p) => p.kind === "agent" && p.address === "") ? 3000 : false,
  });
  const timeline = useQuery({
    queryKey: workbenchKeys.timeline(workbenchTenantId),
    queryFn: () => readWorkbench(workbenchTenantId),
  });

  // Invalidates rather than patches: the stream carries no thread
  // identity. Also invalidates approvals, since a parked ask sends no
  // mail but still ticks the stream. An agent reply may have saved an
  // artifact too, so the panel and library counts stay in sync.
  useEffect(
    () =>
      subscribeToInbox(workbenchTenantId, () => {
        void queryClient.invalidateQueries({
          queryKey: workbenchKeys.scope(workbenchTenantId),
        });
        void queryClient.invalidateQueries({
          queryKey: tenantKeys.pendingApprovals(workbenchTenantId),
        });
        void queryClient.invalidateQueries({
          queryKey: tenantKeys.artifacts(workbenchTenantId),
        });
      }),
    [workbenchTenantId, queryClient],
  );

  const agents = (participants.data ?? []).filter((participant) => participant.kind === "agent");
  // Released by a hub restart: the asset is still here but nothing is live.
  const releasedAgents = agents.filter(
    (agent): agent is WorkbenchParticipant & { assetName: string } =>
      agent.address === "" && agent.assetName !== undefined,
  );
  const startingAgent = releasedAgents[0];
  const workerStatus = useWorkerStatus(workbenchTenantId, agents[0]?.id);
  // Only a live agent can be addressed, so only one can be mentioned.
  const mentionables = agents
    .filter((agent) => agent.address.includes("@"))
    .map((agent) => ({ id: agent.id, name: agent.name }));
  const send = useMutation({
    mutationFn: ({
      content,
      inReplyTo,
    }: {
      readonly content: string;
      readonly inReplyTo?: string;
    }) =>
      sendToWorkbench({
        workbenchTenantId,
        participants: participants.data ?? [],
        content,
        ...(inReplyTo !== undefined ? { inReplyTo } : {}),
      }),
    onMutate: () => markTurnPending(queryClient, workbenchTenantId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: workbenchKeys.scope(workbenchTenantId),
      }),
    onError: () => queryClient.setQueryData(workbenchKeys.pendingTurn(workbenchTenantId), null),
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
          workbenchTenantId={workbenchTenantId}
          agent={{ id: agent.id, name: agent.name, assetName: agent.assetName }}
        />
      ))}
      <div className="wb" data-drawer={drawerOpen ? "open" : "closed"}>
        <div className="wb-thread workbench-layout">
          <BenchPill
            benchName={tenant.data?.name ?? "Workbench"}
            worker={agents[0]}
            status={workerStatus}
            open={drawerOpen}
            onToggle={() => setDrawerOpen((open) => !open)}
          />
          <div className="workbench-main">
            <div className="workbench-main-scroll">
              <PageShell width="prose" className="page-fill">
                <div className="chat-thread-messages">
                  {messages.map((message) => (
                    <WorkbenchMessageRow
                      key={message.id}
                      message={message}
                      participants={participants.data ?? []}
                      workbenchTenantId={workbenchTenantId}
                      onReply={(target) => setOpenThread(target.messageId)}
                    />
                  ))}
                  <PendingOpeningMessage
                    workbenchTenantId={workbenchTenantId}
                    participants={participants.data ?? []}
                  />
                </div>
                {send.error === null ? null : (
                  <p className="chat-thread-error">{errorText(send.error)}</p>
                )}
              </PageShell>
            </div>
            <div className="workbench-main-composer">
              <PageShell width="prose" className="page-fill">
                <Composer
                  placeholder={
                    startingAgent === undefined
                      ? "Message this workbench"
                      : `${startingAgent.name} is starting…`
                  }
                  busy={send.isPending}
                  disabled={startingAgent !== undefined}
                  mentionables={mentionables}
                  onSend={(text) => send.mutate({ content: text })}
                  onVoice={() => {
                    setDrawerOpen(false);
                    setVoiceOpen(true);
                  }}
                />
              </PageShell>
            </div>
          </div>
          {opened === undefined ? null : (
            <aside className="workbench-subthread" aria-label="Replies">
              <div className="workbench-subthread-head">
                <h2>Replies</h2>
                <Button variant="ghost" size="sm" onClick={() => setOpenThread(null)}>
                  Close
                </Button>
              </div>
              <div className="chat-thread-messages">
                {openedChain.map((message) => (
                  <WorkbenchMessageRow
                    key={message.id}
                    message={message}
                    participants={participants.data ?? []}
                    workbenchTenantId={workbenchTenantId}
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
                mentionables={mentionables}
                onSend={(text) => send.mutate({ content: text, inReplyTo: opened.messageId })}
              />
            </aside>
          )}
          {voiceOpen ? (
            <VoiceOverlay
              worker={agents[0]}
              messages={messages}
              onSend={(text) => send.mutate({ content: text })}
              onEnd={endVoice}
            />
          ) : null}
        </div>
        <BenchDrawer
          open={drawerOpen}
          title={tenant.data?.name ?? "Workbench"}
          subtitle={workerStatus.text}
          onClose={closeDrawer}
          tabs={{
            Information: (
              <InformationTab
                workbenchTenantId={workbenchTenantId}
                latestMessage={latestMessage}
                participants={participants.data ?? []}
              />
            ),
            Artifacts: <ArtifactsTab workbenchTenantId={workbenchTenantId} />,
            Tools: <ToolsTab workbenchTenantId={workbenchTenantId} />,
            Grants: <GrantsTab workbenchTenantId={workbenchTenantId} />,
            Insights: <InsightsTab workbenchTenantId={workbenchTenantId} />,
            Members: (
              <MembersTab
                workbenchTenantId={workbenchTenantId}
                participants={participants.data ?? []}
              />
            ),
            Workflows: <WorkflowsTab workbenchTenantId={workbenchTenantId} />,
          }}
        />
      </div>
    </div>
  );
}

export function WorkbenchRoute({ path }: { readonly path: string }) {
  const { selectedTenantId } = useBench();
  const workbenchTenantId = workbenchIdFromPath(path);

  // The recency signal `/` reads: visiting a workbench records it, so home
  // lands back here. Guarded inside (not an early return) so the hook
  // order stays stable across renders.
  useEffect(() => {
    if (selectedTenantId !== null && workbenchTenantId !== null) {
      recordLastWorkbenchId(selectedTenantId, workbenchTenantId);
    }
  }, [selectedTenantId, workbenchTenantId]);

  if (selectedTenantId === null || workbenchTenantId === null) {
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
  return <Workbench workbenchTenantId={workbenchTenantId} />;
}
