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
} from "@workbench/chat";
import {
  friendlyToolSummary,
  summarizeToolCalls,
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
import { useAttachShortcut } from "../hooks/use-attach-shortcut";
import { ActiveContextPills } from "./ActiveContextPills";

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
  /** Optional thread label shown as the agent tagline (multi-thread chat). */
  threadLabel?: string;
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
   * Resume a pending gate. Must reject on failure (it returns the resume
   * mutation's promise, NOT a pre-swallowed one) so this surface can surface the
   * reason and — for the free-text path — fall back to posting the text as a
   * normal chat turn rather than silently losing the user's message (CL-2681).
   */
  onResumeSignal?: (
    runId: string,
    signalName: string,
    text: string,
  ) => Promise<void>;
  /**
   * The resume mutation's `isPending`. Threaded in as the double-fire guard: a
   * rapid second Enter/click while a resume is in flight is ignored, so at most
   * one resume fires per gate (CL-2681).
   */
  resumeInFlight?: boolean;
};

export function MyraChatSurface({
  session,
  threadLabel,
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
      void onResumeSignal(runId, signalName, text).catch((err: unknown) => {
        // The resume failed (e.g. a stale-gate 409) — never lose the user's
        // text: post it as a normal chat turn and surface the reason.
        setResumeError(resumeFailureMessage(err));
        void session.send(text);
      });
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

  // A gate choice block (CL-2682 routes these through this handler) carries its
  // `awaitSignal` name; route it through the resume path — same contract as the
  // dock card — instead of posting the option value as a chat turn (FIX 3). The
  // target run is the conversation's sole pending gate. On failure surface the
  // reason (the choice value, unlike free text, is not re-posted as a turn).
  const handleRespond = (response: UIResponse) => {
    setResumeError(null);
    if (
      response.signalName !== undefined &&
      onResumeSignal !== undefined &&
      signalRouting?.mode === "single"
    ) {
      if (resumeInFlight) return;
      void onResumeSignal(
        signalRouting.gate.runId,
        response.signalName,
        response.value,
      ).catch((err: unknown) => setResumeError(resumeFailureMessage(err)));
      return;
    }
    return session.send(response.value);
  };

  // With more than one workflow gate pending, free text cannot pick a run for
  // the user (CL-2681) — tell them to answer from a run's card in the dock.
  const multiGateHint =
    signalRouting?.mode === "multi" ? (
      <p className="text-xs text-text-3" role="note">
        {signalRouting.gates.length} runs are waiting on you. Use a run's card
        in the workflow dock to answer the one you mean.
      </p>
    ) : null;

  const attachedPills =
    attached.length > 0 ? (
      <ActiveContextPills
        attached={attached.map(activeContextToRef)}
        onRemove={removeAttached}
      />
    ) : null;

  const resumeErrorNotice =
    resumeError !== null ? (
      <p className="text-xs text-red" role="alert">
        {resumeError}
      </p>
    ) : null;

  const inputAccessory =
    multiGateHint !== null ||
    attachedPills !== null ||
    resumeErrorNotice !== null ? (
      <div className="space-y-1.5">
        {resumeErrorNotice}
        {multiGateHint}
        {attachedPills}
      </div>
    ) : null;

  return (
    <ChatPanel
      {...chrome}
      messages={session.messages}
      {...(inserts !== undefined ? { inserts } : {})}
      onSend={handleSend}
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
      compactToolActivity={compactToolActivity}
      summarizeToolCalls={summarize}
    />
  );
}
