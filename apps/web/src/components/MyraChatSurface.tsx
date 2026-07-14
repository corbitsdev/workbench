import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Minimize2 } from "lucide-react";
import {
  ChatPanel,
  type ChatAgentIdentity,
  type ChatDockState,
  type ThreadInsert,
  type UIResponse,
  type PendingAttachment,
  type SignalRouting,
  type MentionCandidate,
} from "@workbench/chat";
import {
  friendlyToolSummary,
  friendlyToolResult,
  summarizeToolCalls,
  isCatalogMetaTool,
  isExternalIntegrationTool,
  attachmentPolicyForAgent,
} from "@workbench/agents/browser";
import { useCompactToolActivity, useToolSummaryStyle } from "@workbench/ui";
import type { ToolCall } from "@workbench/chat";
import {
  activeContextToRef,
  projectActiveContext,
  type ActiveContext,
  type ActiveContextRef,
} from "@workbench/shared";
import type { MyraSession } from "../hooks/use-myra-session";
import { useActiveContext } from "../lib/active-context-store";
import { resolveResumePayload } from "../lib/resume-payload";
import { useAttachShortcut } from "../hooks/use-attach-shortcut";
import { ActiveContextPills } from "./ActiveContextPills";
import { ReviewGate } from "./ReviewGate";
import { ToolCallProviderMarker } from "./ToolCallProviderMarker";

/**
 * Near-full-screen overlay wrapping the whole chat panel while expanded so the
 * thread switcher rides along into fullscreen. Unlike the
 * dock's plain expand, this is always dismissible: Escape and the visible
 * minimize button both collapse back (via `onExit`) — they never close the
 * chat. Body scroll is locked while open and restored on exit so the
 * underlying page is never left trapped.
 */
export function ExpandedChatOverlay({
  children,
  open,
  onExit,
}: {
  children: ReactNode;
  open: boolean;
  onExit: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onExit();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onExit]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label="Expanded chat"
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.98 }}
          transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
          className="fixed inset-4 z-50 flex flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-[0_10px_40px_rgba(0,0,0,0.4)]"
        >
          <div className="flex shrink-0 items-center justify-end border-b border-border px-2 py-1.5">
            <button
              type="button"
              onClick={onExit}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-2 hover:bg-surface-2 hover:text-text cursor-pointer transition-[transform,background-color,color] duration-150 ease-out active:scale-[0.97]"
            >
              <Minimize2 className="h-3.5 w-3.5" />
              Minimize
            </button>
          </div>
          <div className="min-h-0 flex-1">{children}</div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

const MYRA: ChatAgentIdentity = { name: "Myra", tagline: "Personal agent" };

// Myra runs on Kimi via the openai-compatible adapter, which reads images but
// not documents; the gate resolves that to images-only. Undefined (attachments
// hidden) if the capability ever resolves to none.
const MYRA_ATTACHMENT_POLICY = attachmentPolicyForAgent(MYRA.name);

// Myra's file tools are private working memory (MEMORY.md, SCRATCHPAD.md).
// Hide those tool-call lines from the thread so her self-management does not
// clutter the conversation.
const PRIVATE_FILE_TOOLS = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "search_files",
]);
const hideMyraSelfManagement = (call: { name: string }): boolean =>
  PRIVATE_FILE_TOOLS.has(call.name);

type MyraChatSurfaceProps = {
  session: MyraSession;
  /**
   * Active Interchange tenant. When present, an inline approval gate is mounted
   * so a side-effect tool call parked on approval can be resolved from the chat.
   */
  tenantId?: string | null;
  /** Optional thread label shown as the agent tagline (multi-thread chat). */
  threadLabel?: string;
  /**
   * Content for the left of the panel's single header bar (e.g. the thread
   * switcher), collapsing what used to be a separate switcher row into the one
   * ChatPanel header.
   */
  headerLeft?: ReactNode;
  /** Notified with the text whenever the user sends a message (for auto-title). */
  onUserSend?: (text: string) => void;
  /** Run-addressed workflow-event bubbles interleaved into the thread (CL-2682). */
  inserts?: ThreadInsert[];
  dockState?: ChatDockState;
  onToggleDock?: () => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
  onClose?: () => void;
  /**
   * HITL signal routing for this conversation's pending workflow gates
   * (CL-2681). When exactly one gate is pending (`mode: "single"`), free text
   * typed here is delivered to that gate via `onResumeSignal` instead of a chat
   * turn; with more than one pending gate (`mode: "multi"`), free text stays a
   * normal chat turn and a hint tells the user to use a run's card button.
   */
  signalRouting?: SignalRouting;
  /**
   * Resume a pending gate with a resolved payload (CL-2684). The caller passes
   * the verbatim resume payload — a block response's structured payload, or a
   * free-text `{ instruction }` — so a form/choice block resumes through the
   * same contract as the WorkflowDock card, not a `value`-only `{ instruction }`
   * that would drop a form's field map. Must reject on failure (it returns the
   * resume mutation's promise, NOT a pre-swallowed one) so this surface can
   * surface the reason and — for the free-text path — fall back to posting the
   * text as a normal chat turn rather than silently losing the message (CL-2681).
   */
  onResumeSignal?: (
    runId: string,
    signalName: string,
    payload: unknown,
  ) => Promise<void>;
  /**
   * The resume mutation's `isPending`. Threaded in as the double-fire guard: a
   * rapid second Enter/click while a resume is in flight is ignored, so at most
   * one resume fires per gate (CL-2681).
   */
  resumeInFlight?: boolean;
  /** Workspace members eligible for `@` mention autocomplete in the composer. */
  mentionCandidates?: MentionCandidate[];
};

export function MyraChatSurface({
  session,
  tenantId,
  threadLabel,
  headerLeft,
  onUserSend,
  inserts,
  dockState,
  onToggleDock,
  expanded,
  onToggleExpand,
  onClose,
  signalRouting,
  onResumeSignal,
  resumeInFlight,
  mentionCandidates,
}: MyraChatSurfaceProps) {
  const agent: ChatAgentIdentity = threadLabel
    ? { ...MYRA, tagline: threadLabel }
    : MYRA;
  const { compact: compactToolActivity } = useCompactToolActivity();
  const { style: toolSummaryStyle } = useToolSummaryStyle();
  const summarize = (calls: ToolCall[]) =>
    summarizeToolCalls(calls, toolSummaryStyle);

  const activeContext = useActiveContext();
  const [attached, setAttached] = useState<ActiveContext[]>([]);
  // Sanitized reason for a failed gate resume (CL-2681), shown above the prompt.
  const [resumeError, setResumeError] = useState<string | null>(null);

  const attachCurrent = useCallback((): boolean => {
    if (!activeContext) return false;
    setAttached((prev) =>
      prev.some(
        (c) => c.kind === activeContext.kind && c.id === activeContext.id,
      )
        ? prev
        : [...prev, activeContext],
    );
    return true;
  }, [activeContext]);
  useAttachShortcut(attachCurrent);

  const removeAttached = (ref: ActiveContextRef) =>
    setAttached((prev) =>
      prev.filter((c) => !(c.kind === ref.kind && c.id === ref.id)),
    );

  const chrome = {
    agent,
    dockState,
    onToggleDock,
    expanded,
    onToggleExpand,
    onClose,
    // Docked context aligns the composer to the message column; the wide
    // full-page/expanded surfaces keep the centered prompt. A docked panel that
    // is then Expanded goes near-fullscreen, so it wants the centered prompt too.
    composerFullWidth: dockState === "docked" && expanded !== true,
    ...(headerLeft !== undefined ? { headerLeft } : {}),
    ...(mentionCandidates !== undefined && mentionCandidates.length > 0
      ? { mentionCandidates }
      : {}),
  };

  const { state } = session;

  if (state.phase === "loading") {
    return (
      <ChatPanel
        {...chrome}
        messages={[]}
        onSend={() => undefined}
        inputDisabled
      />
    );
  }

  if (state.phase === "provisioning") {
    return (
      <ChatPanel
        {...chrome}
        messages={[]}
        onSend={() => undefined}
        inputDisabled
        notice={<span>Setting up Myra for your workspace…</span>}
      />
    );
  }

  if (state.phase === "credential-error") {
    return (
      <ChatPanel
        {...chrome}
        messages={[]}
        onSend={() => undefined}
        inputDisabled
        notice={
          <span>
            No API credential is set up for Myra. Ask your admin to finish
            workspace setup.
          </span>
        }
      />
    );
  }

  if (state.phase === "error") {
    return (
      <ChatPanel
        {...chrome}
        messages={[]}
        onSend={() => undefined}
        inputDisabled
        notice={
          <span>
            Couldn't reach Myra.{" "}
            <button
              type="button"
              onClick={session.reconnect}
              className="text-orange underline"
            >
              Try again
            </button>
            .
          </span>
        }
      />
    );
  }

  // A non-recoverable launch failure (e.g. auth). Terminal — no background
  // retry — but a manual Try again still re-attempts in case it was momentary.
  if (state.phase === "fatal") {
    return (
      <ChatPanel
        {...chrome}
        messages={[]}
        onSend={() => undefined}
        inputDisabled
        notice={
          <span>
            Myra couldn't start.{" "}
            <button
              type="button"
              onClick={session.reconnect}
              className="text-orange underline"
            >
              Try again
            </button>
            .
          </span>
        }
      />
    );
  }

  // Attachments are projected to a compact lead-in and composed inline into the
  // message. Inline (not a first-class Interchange attachment) because Myra's
  // DeepSeek/openai-compatible harness does not ingest document attachment
  // ContentBlocks (CL-2495 spike). Cleared once the send is dispatched.
  const resumeFailureMessage = (err: unknown): string =>
    err instanceof Error && err.message.trim().length > 0
      ? err.message
      : "Couldn't send your response to the workflow. Please try again.";

  const handleSend = (text: string, attachments?: PendingAttachment[]) => {
    setResumeError(null);
    // Single pending gate: free text is the gate's answer, not a chat turn
    // (CL-2681). Routed only when there are NO attachments AND no active-context
    // pills — both are conversation acts, not gate payloads (FIX 4). With >1 gate
    // pending we do NOT auto-route (the hint below tells the user to use a card).
    const noAttachments =
      (attachments === undefined || attachments.length === 0) &&
      attached.length === 0;
    if (
      signalRouting?.mode === "single" &&
      onResumeSignal !== undefined &&
      noAttachments &&
      text.trim().length > 0
    ) {
      // Double-fire guard: ignore a second Enter while a resume is in flight.
      if (resumeInFlight) return;
      const { runId, signalName } = signalRouting.gate;
      onUserSend?.(text);
      // Free text is the gate's answer wrapped as an instruction (the pre-block
      // HITL path) — no block payload here.
      void onResumeSignal(runId, signalName, { instruction: text }).catch(
        (err: unknown) => {
          // The resume failed (e.g. a stale-gate 409) — never lose the user's
          // text: post it as a normal chat turn and surface the reason.
          setResumeError(resumeFailureMessage(err));
          void session.send(text);
        },
      );
      return;
    }
    onUserSend?.(text);
    const composed =
      attached.length === 0
        ? text
        : `${attached
            .map((c) => projectActiveContext(c).leadIn)
            .join("\n\n")}\n\n${text}`;
    if (attached.length > 0) setAttached([]);
    return session.send(composed, attachments);
  };

  // A gate block (choice/form/multiSelect) carries its `awaitSignal` name; route
  // it through the resume path with its RESOLVED payload — the same shared
  // contract as the dock card (CL-2684) — instead of posting the value as a chat
  // turn. A form emits `value: ""` with its field map in `payload`, so we must
  // forward the resolved payload verbatim, never the bare value (FIX 3). The
  // target run is the conversation's sole pending gate. On failure surface the
  // reason (a block response, unlike free text, is not re-posted as a turn).
  const handleRespond = (response: UIResponse): void | Promise<void> => {
    setResumeError(null);
    if (
      response.signalName !== undefined &&
      onResumeSignal !== undefined &&
      signalRouting?.mode === "single"
    ) {
      if (resumeInFlight) return;
      // Return the resume promise so the interactive block awaits it and shows
      // its own inline pending/error, keeping the user's typed input on failure
      // (CL-2684). A block response is not re-posted as a chat turn, so the
      // rejection propagates to the block instead of the accessory notice.
      return onResumeSignal(
        signalRouting.gate.runId,
        response.signalName,
        resolveResumePayload(response),
      ).then(() => undefined);
    }
    session.send(response.value);
  };

  // With more than one workflow gate pending, free text cannot pick a run for
  // the user (CL-2681) — tell them to answer from a run's card in the dock.
  const multiGateHint =
    signalRouting?.mode === "multi" ? (
      <p key="multi-gate-hint" className="text-xs text-text-3" role="note">
        {signalRouting.gates.length} runs are waiting on you. Use a run's card
        in the workflow dock to answer the one you mean.
      </p>
    ) : null;

  const attachedPills =
    attached.length > 0 ? (
      <ActiveContextPills
        key="attached-pills"
        attached={attached.map(activeContextToRef)}
        onRemove={removeAttached}
      />
    ) : null;

  const resumeErrorNotice =
    resumeError !== null ? (
      <p key="resume-error" className="text-xs text-red" role="alert">
        {resumeError}
      </p>
    ) : null;

  // History renders while the sidecar is unreachable; the composer stays usable
  // and sends are queued. Tell the user their messages are deferred, without
  // surfacing a raw error (CL-3280). A never-yet-live first connect says
  // "Connecting"; a drop after a live session says "Reconnecting" (CL-3292). The
  // Retry button sits OUTSIDE the role="status" live region so assistive tech
  // announces the status text alone and exposes the control through the normal
  // focus order.
  let connectionCopy: string | null = null;
  if (session.connectionNotice === "connecting") {
    connectionCopy =
      "Connecting to Myra — your messages will send once connected.";
  } else if (session.connectionNotice === "reconnecting") {
    if (session.queuedFailed) {
      connectionCopy =
        "Trouble reaching Myra — still trying. Your messages will send once it's back.";
    } else {
      connectionCopy =
        "Reconnecting to Myra — your messages will send once it's back.";
    }
  }

  const reconnectingNotice =
    connectionCopy !== null ? (
      <div
        key="reconnecting-notice"
        className="flex items-center gap-1.5 text-xs"
      >
        <span role="status" className="text-text-3">
          {connectionCopy}
        </span>
        {session.queuedFailed && (
          <button
            type="button"
            onClick={session.reconnect}
            className="text-orange underline"
          >
            Retry now
          </button>
        )}
      </div>
    ) : null;

  // Mounted (not conditionally rendered) whenever a tenant is known so its SSE
  // subscription is live; it renders nothing until a pending approval exists.
  // Event-driven (CL-3285) — no interval poll. Tenant-scoped: the interchange
  // runtime sessionId that approvals carry is not exposed on MyraSession, so the
  // client cannot session-filter yet; the ownership-scoped list route already
  // limits what the caller sees. Placed first so the actionable approval
  // interrupt sits above the transient hints.
  const reviewGate = tenantId ? (
    <ReviewGate
      key="review-gate"
      tenantId={tenantId}
      sessionId={session.sessionId ?? undefined}
      sessionScope="session"
    />
  ) : null;

  // Single source of truth for the composer accessories: render order and the
  // "anything to show?" condition come from the same list. Each element carries
  // a stable key so identity survives siblings appearing or disappearing.
  const accessories = [
    reviewGate,
    reconnectingNotice,
    resumeErrorNotice,
    multiGateHint,
    attachedPills,
  ].filter((accessory) => accessory !== null);

  const inputAccessory =
    accessories.length > 0 ? (
      <div className="space-y-1.5">{accessories}</div>
    ) : null;

  return (
    <ChatPanel
      {...chrome}
      messages={session.messages}
      {...(inserts !== undefined ? { inserts } : {})}
      onSend={handleSend}
      onAbort={session.abortTurn}
      onRespond={handleRespond}
      inputAccessory={inputAccessory}
      {...(MYRA_ATTACHMENT_POLICY !== undefined
        ? { attachmentPolicy: MYRA_ATTACHMENT_POLICY }
        : {})}
      activity={session.activity}
      onRate={session.onRate}
      getRating={session.getRating}
      {...(session.resolveAttachmentUrl !== undefined
        ? { resolveAttachmentUrl: session.resolveAttachmentUrl }
        : {})}
      hideToolCall={hideMyraSelfManagement}
      formatToolSummary={friendlyToolSummary}
      formatToolResult={friendlyToolResult}
      formatToolName={(name) => friendlyToolSummary({ id: "", name })}
      compactToolActivity={compactToolActivity}
      summarizeToolCalls={summarize}
      isQuietTool={isCatalogMetaTool}
      isExternalTool={isExternalIntegrationTool}
      renderToolMarker={(ctx) => <ToolCallProviderMarker call={ctx.call} />}
    />
  );
}
