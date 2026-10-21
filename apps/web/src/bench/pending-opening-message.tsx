// The first message of a new workbench, shown as a pending own bubble until
// the agent is live and the send lands. Past the cap it stays here with a
// retry; it is only cleared once the send succeeds.

import { Button } from "@corbits/react-ui";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { sendToWorkbench, type WorkbenchParticipant } from "@/chat/threads-api";
import { WorkingLabel } from "@/chat/working-label";
import { workbenchKeys } from "../chat-path";
import { clearOpeningMessage, readOpeningMessage } from "../opening-message";
import { markTurnPending } from "../worker-status";
import "./pending-opening-message.css";

const CAP_MS = 60_000;

export async function dispatchOpeningMessage({
  queryClient,
  workbenchTenantId,
  participants,
  content,
  send = sendToWorkbench,
}: {
  readonly queryClient: QueryClient;
  readonly workbenchTenantId: string;
  readonly participants: readonly WorkbenchParticipant[];
  readonly content: string;
  readonly send?: typeof sendToWorkbench;
}): Promise<void> {
  markTurnPending(queryClient, workbenchTenantId);
  try {
    await send({
      workbenchTenantId,
      participants,
      content,
    });
  } catch (cause) {
    queryClient.setQueryData(workbenchKeys.pendingTurn(workbenchTenantId), null);
    throw cause;
  }
  clearOpeningMessage(workbenchTenantId);
  await queryClient.invalidateQueries({ queryKey: workbenchKeys.scope(workbenchTenantId) });
}

export interface PendingOpeningMessageSession {
  readonly workbenchTenantId: string;
  readonly text: string | null;
  readonly timedOut: boolean;
}

export function createPendingOpeningMessageSession(
  workbenchTenantId: string,
): PendingOpeningMessageSession {
  return {
    workbenchTenantId,
    text: readOpeningMessage(workbenchTenantId),
    timedOut: false,
  };
}

export function syncPendingOpeningMessageSession(
  session: PendingOpeningMessageSession,
  workbenchTenantId: string,
): PendingOpeningMessageSession {
  if (session.workbenchTenantId === workbenchTenantId) return session;
  return createPendingOpeningMessageSession(workbenchTenantId);
}

export function PendingOpeningMessage({
  workbenchTenantId,
  participants,
}: {
  readonly workbenchTenantId: string;
  readonly participants: readonly WorkbenchParticipant[];
}) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState(() =>
    createPendingOpeningMessageSession(workbenchTenantId),
  );
  const current = syncPendingOpeningMessageSession(session, workbenchTenantId);
  if (current !== session) {
    setSession(current);
  }
  const attemptedTenantId = useRef<string | null>(null);
  const text = current.text;
  const timedOut = current.timedOut;

  useEffect(() => {
    const timer = setTimeout(
      () =>
        setSession((prev) =>
          prev.workbenchTenantId === workbenchTenantId ? { ...prev, timedOut: true } : prev,
        ),
      CAP_MS,
    );
    return () => clearTimeout(timer);
  }, [workbenchTenantId]);

  const send = useMutation({
    mutationFn: ({
      targetTenantId,
      targetParticipants,
      content,
    }: {
      readonly targetTenantId: string;
      readonly targetParticipants: readonly WorkbenchParticipant[];
      readonly content: string;
    }) =>
      dispatchOpeningMessage({
        queryClient,
        workbenchTenantId: targetTenantId,
        participants: targetParticipants,
        content,
      }),
    onSuccess: (_data, variables) => {
      setSession((prev) =>
        prev.workbenchTenantId === variables.targetTenantId ? { ...prev, text: null } : prev,
      );
    },
  });

  const live = participants.some((p) => p.kind === "agent" && p.address.includes("@"));
  // Fires from an effect, never during render: mutating mid-render updates
  // the mutation's own state on a fiber that hasn't mounted yet (React
  // warns), and StrictMode double-renders would double-send without the
  // ref guard.
  useEffect(() => {
    if (text === null || !live || attemptedTenantId.current === workbenchTenantId || send.isPending)
      return;
    attemptedTenantId.current = workbenchTenantId;
    send.mutate({
      targetTenantId: workbenchTenantId,
      targetParticipants: participants,
      content: text,
    });
  });

  if (text === null) return null;

  const failed = send.isError || (timedOut && !live);

  return (
    <>
      <div className="chat-thread-message" data-author="me" data-pending="true">
        <div className="chat-thread-body">
          <div className="chat-thread-own-bubble">{text}</div>
          {failed ? (
            <p className="chat-thread-error">
              This message hasn&apos;t been sent yet.{" "}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (live) {
                    send.mutate({
                      targetTenantId: workbenchTenantId,
                      targetParticipants: participants,
                      content: text,
                    });
                  } else {
                    void queryClient.invalidateQueries({
                      queryKey: workbenchKeys.participants(workbenchTenantId),
                    });
                  }
                  setSession((prev) =>
                    prev.workbenchTenantId === workbenchTenantId
                      ? { ...prev, timedOut: false }
                      : prev,
                  );
                }}
              >
                Retry
              </Button>
            </p>
          ) : (
            <p className="chat-thread-status">Sending once the agent is ready…</p>
          )}
        </div>
      </div>
      {/* Once live, the send marks the turn pending and the page's own
          working label takes over until the reply lands. */}
      {failed || live ? null : <WorkingLabel />}
    </>
  );
}
