// A workbench is a child tenant, and its room is that tenant's mailbox:
// the timeline is the tenant's mail threads, participants are its
// principals, and a message is addressed to every agent in the room.
// Sub-threads are native in-reply-to chains, shown in a side panel.

import { Button, EmptyState, PageShell, Textarea } from "@corbits/react-ui";
import { WarningCircle } from "@/lib/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Markdown } from "@/chat/markdown";
import {
  agentInitials,
  listRoomParticipants,
  readRoom,
  sendToRoom,
  subscribeToInbox,
  type RoomMessage,
  type RoomParticipant,
} from "@/chat/threads-api";
import { useBench } from "../bench-context";
import { createFetchStockHub } from "../needs-converge";
import { roomKeys } from "../chat-path";
import { StageTopBar } from "../shell/stage-top-bar";
import { workbenchIdFromPath } from "../workbench-path";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function RoomComposer({
  placeholder,
  busy,
  onSend,
}: {
  readonly placeholder: string;
  readonly busy: boolean;
  readonly onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const send = () => {
    const trimmed = text.trim();
    if (trimmed === "" || busy) return;
    setText("");
    onSend(trimmed);
  };
  return (
    <div className="chat-composer">
      <Textarea
        value={text}
        rows={3}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}
      />
      <Button variant="primary" disabled={busy || text.trim() === ""} onClick={send}>
        {busy ? "Sending…" : "Send"}
      </Button>
    </div>
  );
}

function RoomMessageRow({
  message,
  onOpenReplies,
}: {
  readonly message: RoomMessage;
  readonly onOpenReplies: (message: RoomMessage) => void;
}) {
  return (
    <div className="chat-thread-message" data-author={message.author}>
      <span className="shell-ch-avatar">
        <span className="shell-ch-initial" aria-hidden="true">
          {message.author === "me" ? "You" : agentInitials(message.authorName)}
        </span>
      </span>
      <div className="chat-thread-body">
        <Markdown text={message.body} />
        {message.replies.length === 0 ? null : (
          <button
            type="button"
            className="room-replies-link"
            onClick={() => onOpenReplies(message)}
          >
            {message.replies.length === 1 ? "1 reply" : `${String(message.replies.length)} replies`}
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
            <span className="shell-ch-initial" aria-hidden="true">
              {agentInitials(participant.name)}
            </span>
          </span>
          {participant.name}
        </li>
      ))}
    </ul>
  );
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
  const opened = messages.find((message) => message.id === openThread);
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
      <StageTopBar crumbs={[{ label: tenant.data?.name ?? "Workbench" }]} />
      <div className="room-layout">
        <PageShell width="prose" className="page-fill">
          <ParticipantList participants={participants.data ?? []} />
          <div className="chat-thread-messages">
            {messages.map((message) => (
              <RoomMessageRow
                key={message.id}
                message={message}
                onOpenReplies={(target) => setOpenThread(target.id)}
              />
            ))}
          </div>
          {send.error === null ? null : (
            <p className="chat-thread-error">{errorText(send.error)}</p>
          )}
          <RoomComposer
            placeholder="Message this workbench"
            busy={send.isPending}
            onSend={(text) => send.mutate({ content: text })}
          />
        </PageShell>
        {opened === undefined ? null : (
          <aside className="room-subthread" aria-label="Replies">
            <div className="room-subthread-head">
              <h2>Replies</h2>
              <Button variant="ghost" size="sm" onClick={() => setOpenThread(null)}>
                Close
              </Button>
            </div>
            <div className="chat-thread-messages">
              {[opened, ...opened.replies].map((message) => (
                <RoomMessageRow
                  key={message.id}
                  message={message}
                  onOpenReplies={() => undefined}
                />
              ))}
            </div>
            <RoomComposer
              placeholder="Reply in this thread"
              busy={send.isPending}
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
