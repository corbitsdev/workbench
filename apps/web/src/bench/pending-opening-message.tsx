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
    mutationFn: (content: string) => sendToWorkbench({ workbenchTenantId, participants, content }),
    onSuccess: () => {
      clearOpeningMessage(workbenchTenantId);
      setText(null);
      void queryClient.invalidateQueries({ queryKey: workbenchKeys.scope(workbenchTenantId) });
    },
  });

  if (text === null) return null;

  const live = participants.some((p) => p.kind === "agent" && p.address.includes("@"));
  if (live && !attempted.current && !send.isPending) {
    attempted.current = true;
    send.mutate(text);
  }
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
