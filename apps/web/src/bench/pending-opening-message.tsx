// The first message of a new workbench, shown as a pending own bubble until
// the agent is live and the send lands. Past the cap it stays here with a
// retry; it is only cleared once the send succeeds.

import { Button } from "@corbits/react-ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { sendToWorkbench, type WorkbenchParticipant } from "@/chat/threads-api";
import { workbenchKeys } from "../chat-path";
import { clearOpeningMessage, readOpeningMessage } from "../opening-message";
import "./pending-opening-message.css";

const CAP_MS = 60_000;

export function PendingOpeningMessage({
  workbenchTenantId,
  participants,
}: {
  readonly workbenchTenantId: string;
  readonly participants: readonly WorkbenchParticipant[];
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(() => readOpeningMessage(workbenchTenantId));
  const [timedOut, setTimedOut] = useState(false);
  const attempted = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), CAP_MS);
    return () => clearTimeout(timer);
  }, []);

  const send = useMutation({
    mutationFn: (content: string) =>
      sendToWorkbench({
        workbenchTenantId,
        participants,
        content,
      }),
    onSuccess: () => {
      clearOpeningMessage(workbenchTenantId);
      setText(null);
      void queryClient.invalidateQueries({ queryKey: workbenchKeys.scope(workbenchTenantId) });
    },
  });

  const live = participants.some((p) => p.kind === "agent" && p.address.includes("@"));
  // Fires from an effect, never during render: mutating mid-render updates
  // the mutation's own state on a fiber that hasn't mounted yet (React
  // warns), and StrictMode double-renders would double-send without the
  // ref guard.
  useEffect(() => {
    if (text === null || !live || attempted.current || send.isPending) return;
    attempted.current = true;
    send.mutate(text);
  });

  if (text === null) return null;

  const failed = send.isError || (timedOut && !live);

  return (
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
                if (live) send.mutate(text);
                else
                  void queryClient.invalidateQueries({
                    queryKey: workbenchKeys.participants(workbenchTenantId),
                  });
                setTimedOut(false);
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
  );
}
