import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { Info } from "lucide-react";
import type { ThreadInsert } from "@workbench/chat";
import { ChatThreadInfoDialog } from "../components/ChatThreadInfoDialog";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { MyraChatSurface } from "../components/MyraChatSurface";
import { SubagentDock } from "../components/SubagentDock";
import { WorkflowDock } from "../components/WorkflowDock";
import { WorkflowEventBubble } from "../components/WorkflowEventBubble";
import { useMyraSession } from "../hooks/use-myra-session";
import { useMembers } from "../hooks/use-members";
import { useAgentInstances } from "../hooks/use-agents";
import { useTenantRoster } from "../hooks/use-tenant-roster";
import { useConversationGates } from "../hooks/use-conversation-gates";
import { useResumeConversationGate } from "../hooks/use-workflow";
import { useWorkflowRunEvents } from "../hooks/use-workflow-run-events";
import { useDockFocus } from "../lib/dock-focus";
import { useActiveWorkbench } from "../lib/active-workbench-context";
import { usePublishActiveContext } from "../lib/active-context-store";
import { humanizeInstanceStatus } from "../lib/instance-status";
import { myraInstanceTraceHref } from "../lib/myra-turn-trace";
import {
  isDefaultThreadLabel,
  resolveActiveThread,
  useAutoTitleFirstMessage,
  useCreateMyraThread,
  useMyraThreads,
  writeLastActiveThreadId,
} from "../hooks/use-myra-threads";

function CenteredNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-6 text-center text-library-body-sm text-text-2">
      {children}
    </div>
  );
}

export function ChatThreadPage() {
  const { threadId } = useParams();
  const navigate = useNavigate();
  const { activeTenantId } = useActiveWorkbench();
  const { data, isLoading, isError, refetch } = useMyraThreads();
  const threads = data?.threads;
  const createThread = useCreateMyraThread();
  const { data: members } = useMembers(activeTenantId);
  const mentionCandidates = (members ?? []).map((m) => ({
    id: m.refId,
    name: m.name,
  }));

  const threadList = threads ?? [];
  const active = resolveActiveThread(threadList, threadId);
  const unknownExplicitThreadId =
    threadId !== undefined &&
    threadId.length > 0 &&
    threadList.length > 0 &&
    active === null;

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
  const maybeTitleFromFirstMessage = useAutoTitleFirstMessage(
    active,
    session.messages,
    session.instanceId,
  );

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

  // A brand-new thread carries the hub's auto-assigned default label
  // ("Chat", "Chat 2", …) until the async title lands — show "New chat"
  // instead of that placeholder in the breadcrumb.
  const activeThreadLabel =
    active !== null && isDefaultThreadLabel(active.label)
      ? "New chat"
      : (active?.label ?? null);

  usePublishActiveContext(
    active && activeThreadLabel !== null
      ? {
          kind: "thread",
          id: active.id,
          label: activeThreadLabel,
          turns: threadTurns,
        }
      : null,
    active ? `${threadTurns.length}:${activeThreadLabel}` : undefined,
  );

  // Run-addressed workflow events (CL-2682): derived from the same conversation
  // runs the dock polls, rendered as their own thread bubbles.
  const runEvents = useWorkflowRunEvents(active?.id ?? null, activeTenantId);
  const inserts: ThreadInsert[] = useMemo(
    () =>
      runEvents.map((event) => ({
        id: event.id,
        at: event.at,
        node: <WorkflowEventBubble event={event} />,
      })),
    [runEvents],
  );

  // "Open in dock" reveals the dock where the requested run's card lives —
  // scroll it into view and pulse it — without reaching into WorkflowDock's
  // internals (CL-2681 owns that file).
  const dockRef = useRef<HTMLDivElement>(null);
  const focus = useDockFocus();
  useEffect(() => {
    if (focus === null) return;
    const el = dockRef.current;
    if (el === null) return;
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    el.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "nearest",
    });
    el.setAttribute("data-dock-focused", "1");
    const timer = window.setTimeout(
      () => el.removeAttribute("data-dock-focused"),
      1200,
    );
    return () => window.clearTimeout(timer);
  }, [focus]);

  // Thread info dialog: reuses the roster query the turn trace link already
  // relies on, plus the Agents-page instance list for the mail address and
  // status — both existing queries, no new hub route. Gated on the dialog
  // being open since they exist only for it.
  const [infoOpen, setInfoOpen] = useState(false);
  const { data: tenantRoster } = useTenantRoster(activeTenantId ?? "", {
    enabled:
      infoOpen && activeTenantId !== null && activeTenantId !== undefined,
  });
  const { data: agentInstances } = useAgentInstances(
    infoOpen ? activeTenantId : null,
  );
  const activeInstance = agentInstances?.find(
    (instance) => instance.id === active?.instanceId,
  );
  const instanceStatus =
    activeInstance !== undefined
      ? humanizeInstanceStatus(activeInstance.status)
      : undefined;
  const traceHref = myraInstanceTraceHref(
    active?.instanceId,
    tenantRoster?.instances,
  );
  const infoButton =
    active !== null ? (
      <button
        type="button"
        onClick={() => setInfoOpen(true)}
        aria-label="Chat details"
        className="grid h-7 w-7 flex-none place-items-center rounded-[8px] text-text-3 transition-colors hover:bg-page hover:text-text active:scale-[0.97]"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
    ) : null;

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
                onSuccess: ({ thread }) => {
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

  if (unknownExplicitThreadId) {
    return (
      <CenteredNotice>
        <div className="flex flex-col items-center gap-2">
          <span>This chat couldn't be found.</span>
          <Link to="/chats" className="text-orange underline">
            Back to all chats
          </Link>
        </div>
      </CenteredNotice>
    );
  }

  // Canonicalize the URL to the resolved thread (bare /chats or last-active
  // fallback). Same instance, so no session churn on the rerender.
  if (active && active.id !== threadId) {
    return <Navigate to={`/chats/${active.id}`} replace />;
  }

  return (
    <ErrorBoundary>
      <div className="flex h-full">
        <div className="h-full min-w-0 flex-1">
          <MyraChatSurface
            session={session}
            tenantId={activeTenantId}
            onUserSend={maybeTitleFromFirstMessage}
            signalRouting={signalRouting}
            resumeInFlight={resumeGate.isPending}
            onResumeSignal={(runId, signalName, payload) =>
              resumeGate
                .mutateAsync({ runId, signalName, payload })
                .then(() => undefined)
            }
            inserts={inserts}
            mentionCandidates={mentionCandidates}
            {...(infoButton !== null ? { headerRight: infoButton } : {})}
          />
          {active !== null && (
            <ChatThreadInfoDialog
              open={infoOpen}
              onClose={() => setInfoOpen(false)}
              title={active.label}
              instanceId={active.instanceId}
              createdAt={active.createdAt}
              {...(activeInstance?.name !== undefined
                ? { agentName: activeInstance.name }
                : {})}
              {...(activeInstance?.address !== undefined
                ? { mailAddress: activeInstance.address }
                : {})}
              {...(instanceStatus !== undefined
                ? { status: instanceStatus }
                : {})}
              {...(traceHref !== undefined ? { traceHref } : {})}
            />
          )}
        </div>
        {/* conversationId == Myra thread id; producers (workflow_start tool,
            chat-initiated starts) stamp the same id as originConversationId. */}
        <div
          ref={dockRef}
          className="flex h-full min-h-0 flex-col motion-safe:transition-shadow data-[dock-focused=1]:shadow-[inset_2px_0_0_0_var(--color-accent)]"
        >
          <SubagentDock
            conversationId={active?.id ?? null}
            tenantId={activeTenantId}
          />
          <div className="min-h-0 flex-1">
            <WorkflowDock
              conversationId={active?.id ?? null}
              tenantId={activeTenantId}
            />
          </div>
        </div>
      </div>
    </ErrorBoundary>
  );
}
