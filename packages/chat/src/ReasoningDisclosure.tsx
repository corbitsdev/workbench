import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { cn, Markdown } from "@workbench/ui";
import {
  CHAT_MARKER_SLOT,
  CHAT_TRACE_DETAIL_PANEL,
  CHAT_TRACE_LABEL,
  CHAT_TRACE_MUTED_BODY,
  CHAT_TRACE_ROW,
} from "./messageRhythm";

// Height/opacity reveal matching ToolNarrative's ExpandReveal: reduced-motion
// users get an instant toggle with no AnimatePresence. Collapsed-by-default
// means streaming and settled turns start closed unless the host persisted an
// expand choice for this messageKey.
function ReasoningReveal({
  open,
  reduceMotion,
  children,
}: {
  open: boolean;
  reduceMotion: boolean;
  children: ReactNode;
}) {
  if (reduceMotion) return open ? <div>{children}</div> : null;
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="content"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.18, ease: EASE_OUT }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export interface ReasoningDisclosureProps {
  /** The agent's reasoning text. */
  reasoning: string;
  /** True while reasoning is still streaming (no answer yet). */
  streaming: boolean;
  /** Stable key for per-message expand prefs (`feedbackId ?? message.id`). */
  messageKey: string;
  /** When provided, disclosure state is remembered per {@link messageKey}. */
  isReasoningExpanded?: (messageKey: string) => boolean;
  setReasoningExpanded?: (messageKey: string, expanded: boolean) => void;
}

// Brand ease-out (repo-root DESIGN.md): snappy settle for small disclosures.
const EASE_OUT = [0.23, 1, 0.32, 1] as const;

/**
 * Collapsible "Reasoning" disclosure — the first row of the agent turn's
 * process trace, sharing the tool rows' marker column and type scale.
 *
 * Collapsed by default. The chevron toggle expands/collapses the trace; when the
 * host supplies {@link isReasoningExpanded} / {@link setReasoningExpanded}, the
 * choice is remembered per {@link messageKey} (including across reload).
 *
 * The label is "Reasoning" (not "Thinking"/"Thoughts") — the brand word list
 * prohibits anthropomorphizing agents; the pulsing marker, not the word,
 * signals that it is active.
 */
export function ReasoningDisclosure({
  reasoning,
  streaming,
  messageKey,
  isReasoningExpanded,
  setReasoningExpanded,
}: ReasoningDisclosureProps) {
  const reduceMotion = useReducedMotion();
  const persisted = isReasoningExpanded?.(messageKey) ?? false;
  const [sessionOverride, setSessionOverride] = useState<boolean | null>(null);
  useEffect(() => {
    setSessionOverride(null);
  }, [messageKey]);
  const open = sessionOverride ?? persisted;

  return (
    <div className="flex w-full flex-col gap-2" data-testid="reasoning-row">
      <button
        type="button"
        onClick={() => {
          const next = !open;
          setSessionOverride(next);
          setReasoningExpanded?.(messageKey, next);
        }}
        aria-label={open ? "Collapse reasoning" : "Expand reasoning"}
        className={cn(
          "relative flex self-start text-left",
          CHAT_TRACE_ROW,
          CHAT_TRACE_LABEL,
          "transition-[transform,color] duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
          "hover:text-text-2 active:scale-[0.97] cursor-pointer",
          // Expand the hit area to ~40px without inflating the visual height.
          "after:absolute after:inset-0 after:-m-2 after:content-['']",
        )}
        aria-expanded={open}
      >
        {/* Marker slot — pulses while streaming, empty when settled, keeping
            the reasoning row aligned with the tool rows below it. */}
        <span
          className={cn(
            "mt-0.5 flex items-center justify-center",
            CHAT_MARKER_SLOT,
          )}
        >
          {streaming ? (
            <span
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-orange motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : null}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 leading-snug">
          <span>Reasoning</span>
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "h-3 w-3 shrink-0 transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
              open && "rotate-90",
            )}
          />
        </span>
      </button>
      <ReasoningReveal open={open} reduceMotion={reduceMotion === true}>
        <div className={CHAT_TRACE_DETAIL_PANEL}>
          <Markdown
            mode={streaming ? "streaming" : "static"}
            className={CHAT_TRACE_MUTED_BODY}
          >
            {reasoning}
          </Markdown>
        </div>
      </ReasoningReveal>
    </div>
  );
}
