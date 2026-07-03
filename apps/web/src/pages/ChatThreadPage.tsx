import { useEffect, useMemo } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { MyraChatSurface } from "../components/MyraChatSurface";
import { WorkflowDock } from "../components/WorkflowDock";
import { useMyraSession } from "../hooks/use-myra-session";
import { useConversationGates } from "../hooks/use-conversation-gates";
import { useResumeConversationGate } from "../hooks/use-workflow";
import { useActiveWorkbench } from "../lib/active-workbench-context";
import { usePublishActiveContext } from "../lib/active-context-store";
import {
  resolveActiveThread,
  useAutoTitleFirstMessage,
  useCreateMyraThread,
  useMyraThreads,
  writeLastActiveThreadId,
} from "../hooks/use-myra-threads";

function CenteredNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-6 text-center text-sm text-text-2">
      {children}
    </div>
  );
}

export function ChatThreadPage() {
  const { threadId } = useParams();
  const navigate = useNavigate();
  const { activeTenantId } = useActiveWorkbench();
  const { data: threads, isLoading, isError, refetch } = useMyraThreads();
  const createThread = useCreateMyraThread();

  const active = resolveActiveThread(threads ?? [], threadId);

  // Remember the resolved thread for the FAB and root redirect. Writes an
  // external store only (no re-render), so an effect is the right tool here.
  useEffect(() => {
    if (active) writeLastActiveThreadId(active.id);
  }, [active]);

  const session = useMyraSession(
    active?.instanceId ?? null,
    activeTenantId,
    active !== null,
  );

  // Auto-title a still-default thread from its first message (best-effort; the
  // hub no-ops if the label is already custom).
  const maybeTitleFromFirstMessage = useAutoTitleFirstMessage(active);

  // HITL signal routing (CL-2681): derive whether free text in the prompt box
  // should reach a pending workflow gate, and the resume mutation that delivers
  // it. Owned here so both the chat surface (free-text routing) and the dock
  // (card buttons) work off the same conversation-scoped derivation.
  const signalRouting = useConversationGates(
    active?.id ?? null,
    activeTenantId,
  );
  const resumeGate = useResumeConversationGate(activeTenantId);

  const threadTurns = useMemo(
    () =>
      session.messages
        .filter(
          (m) =>
            (m.role === "user" || m.role === "agent") &&
            m.kind !== "tool" &&
            m.content.trim().length > 0,
        )
        .map((m) => ({ role: m.role as "user" | "agent", text: m.content })),
    [session.messages],
  );

  usePublishActiveContext(
    active
      ? {
          kind: "thread",
          id: active.id,
          label: active.label ?? "Chat",
          turns: threadTurns,
        }
      : null,
    active ? String(threadTurns.length) : undefined,
  );

  if (isLoading) {
    return <CenteredNotice>Loading your chats…</CenteredNotice>;
  }

  if (isError) {
    return (
      <CenteredNotice>
        <div className="flex flex-col items-center gap-2">
          <span>
            Couldn't load your chats. Check your connection and try again.
          </span>
          <button
            type="button"
            onClick={() => void refetch()}
            className="text-orange underline"
          >
            Try again
          </button>
        </div>
      </CenteredNotice>
    );
  }

  if ((threads?.length ?? 0) === 0) {
    return (
      <CenteredNotice>
        <div className="flex flex-col items-center gap-3">
          <span>You don't have any chats yet.</span>
          <button
            type="button"
            disabled={createThread.isPending}
            onClick={() =>
              createThread.mutate(undefined, {
                onSuccess: (thread) => {
                  writeLastActiveThreadId(thread.id);
                  navigate(`/chats/${thread.id}`, { replace: true });
                },
              })
            }
            className="rounded-[8px] bg-orange px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {createThread.isPending ? "Starting…" : "Start a chat"}
          </button>
        </div>
      </CenteredNotice>
    );
  }

  // Canonicalize the URL to the resolved thread (handles an unknown/stale id or
  // the bare /chats path). Same instance, so no session churn on the rerender.
  if (active && active.id !== threadId) {
    return <Navigate to={`/chats/${active.id}`} replace />;
  }

  return (
    <ErrorBoundary>
      <div className="flex h-full">
        <div className="h-full min-w-0 flex-1">
          <MyraChatSurface
            session={session}
            threadLabel={active?.label}
            onUserSend={maybeTitleFromFirstMessage}
            signalRouting={signalRouting}
            resumeInFlight={resumeGate.isPending}
            onResumeSignal={(runId, signalName, text) =>
              resumeGate
                .mutateAsync({
                  runId,
                  signalName,
                  payload: { instruction: text },
                })
                .then(() => undefined)
            }
          />
        </div>
        {/* conversationId == Myra thread id; producers (workflow_start tool,
            chat-initiated starts) stamp the same id as originConversationId. */}
        <WorkflowDock
          conversationId={active?.id ?? null}
          tenantId={activeTenantId}
        />
      </div>
    </ErrorBoundary>
  );
}
