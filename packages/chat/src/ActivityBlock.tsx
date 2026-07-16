import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { cn, Markdown } from "@workbench/ui";
import type { Part, ToolCall } from "./types";
import { toolPartToCall } from "./parts";
import { ToolNarrative, type ToolNarrativeProps } from "./ToolNarrative";
import { deriveActivityLabel } from "./activity-label";
import {
  CHAT_ACTIVITY_STACK,
  CHAT_MARKER_SLOT,
  CHAT_RESPONSE_STACK,
  CHAT_TRACE_DETAIL_PANEL,
  CHAT_TRACE_INLINE_GAP,
  CHAT_TRACE_LABEL,
  CHAT_TRACE_MARKER_ALIGN,
  CHAT_TRACE_MUTED_BODY,
  CHAT_TRACE_ROW,
} from "./messageRhythm";

// Brand ease-out (repo-root DESIGN.md), shared with the tool/reasoning reveals.
const EASE_OUT = [0.23, 1, 0.32, 1] as const;

// Minimum time the rolling label stays on screen before it is allowed to
// change again (CL-3673) — prevents rapid part transitions from flickering.
const MIN_LABEL_DISPLAY_MS = 500;

export interface ActivityBlockProps {
  /** The turn's ordered parts (already `message.parts ?? liftToParts(message)` — see AgentTurn). */
  parts: Part[];
  /** True while the turn is still in flight. */
  streaming: boolean;
  /** Stable key for per-turn expand prefs (`feedbackId ?? message.id`). */
  messageKey: string;
  isExpanded?: (messageKey: string) => boolean;
  setExpanded?: (messageKey: string, expanded: boolean) => void;
  formatSummary?: ToolNarrativeProps["formatSummary"];
  formatResult?: ToolNarrativeProps["formatResult"];
  summarizeCalls?: ToolNarrativeProps["summarizeCalls"];
  isQuietTool?: ToolNarrativeProps["isQuietTool"];
  isExternalTool?: ToolNarrativeProps["isExternalTool"];
  renderToolMarker?: ToolNarrativeProps["renderToolMarker"];
  onRespond?: ToolNarrativeProps["onRespond"];
  onAction?: ToolNarrativeProps["onAction"];
}

function Reveal({
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
          key="activity-content"
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

/**
 * Debounces the rolling activity label while streaming: a new label is only
 * committed once the previous one has been on screen for at least
 * `MIN_LABEL_DISPLAY_MS`, so a burst of rapid part transitions settles into
 * one visible change rather than flickering (CL-3673). Settled turns (not
 * streaming) always show the latest label immediately.
 */
function useStableLabel(label: string, streaming: boolean): string {
  const [display, setDisplay] = useState(label);
  // Mirrors `display` so the effect can compare without depending on it
  // (depending on `display` would re-arm the timer on every commit).
  const displayRef = useRef(label);
  const lastCommitRef = useRef(Date.now());

  useEffect(() => {
    if (!streaming) {
      displayRef.current = label;
      lastCommitRef.current = Date.now();
      setDisplay(label);
      return;
    }
    if (displayRef.current === label) return;
    const elapsed = Date.now() - lastCommitRef.current;
    const wait = Math.max(0, MIN_LABEL_DISPLAY_MS - elapsed);
    const timer = setTimeout(() => {
      displayRef.current = label;
      lastCommitRef.current = Date.now();
      setDisplay(label);
    }, wait);
    return () => clearTimeout(timer);
  }, [label, streaming]);

  return display;
}

function RollingLabel({ label }: { label: string }) {
  const reduceMotion = useReducedMotion();
  if (reduceMotion === true) {
    return (
      <span className="min-w-0 truncate" data-testid="activity-summary">
        {label}
      </span>
    );
  }
  return (
    <span className="relative min-w-0 truncate" data-testid="activity-summary">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={label}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15, ease: EASE_OUT }}
          className="block truncate"
        >
          {label}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/**
 * A single collapsible block gathering ALL of one turn's process activity —
 * reasoning trace and tool calls — above the answer (CL-3637), rebuilt to
 * walk the turn's ordered `parts` (CL-3679) rather than side reasoning/tool
 * fields. The same structure renders whether the turn is streaming live or
 * loaded from a finished thread, so there is no divergent "live" vs
 * "historical" path.
 *
 * While streaming, exactly one rolling label is visible (the trailing part's
 * activity, cross-faded and debounced — CL-3673). Settled turns show a
 * roll-up of what happened. Tool rows render through the single
 * ToolNarrative treatment (CL-3639); color discipline for tool errors is
 * centralized inside ToolNarrative (CL-3679) — no red here.
 */
export function ActivityBlock({
  parts,
  streaming,
  messageKey,
  isExpanded,
  setExpanded,
  formatSummary,
  formatResult,
  summarizeCalls,
  isQuietTool,
  isExternalTool,
  renderToolMarker,
  onRespond,
  onAction,
}: ActivityBlockProps) {
  const reduceMotion = useReducedMotion();
  const persisted = isExpanded?.(messageKey) ?? false;
  const [sessionOverride, setSessionOverride] = useState<boolean | null>(null);
  useEffect(() => {
    setSessionOverride(null);
  }, [messageKey]);
  // While streaming the activity block IS the single rolling summary line
  // (CL-3758) — the reveal panel must stay closed regardless of any expand
  // pref, or a full multi-paragraph reasoning trace opens mid-stream.
  const open = streaming ? false : (sessionOverride ?? persisted);

  const reasoningText = parts
    .filter((part) => part.type === "reasoning")
    .map((part) => part.text)
    .join("\n");
  const toolCalls: ToolCall[] = parts
    .filter((part) => part.type === "tool")
    .map(toolPartToCall);
  const hasReasoning = reasoningText.trim() !== "";
  const realCalls =
    isQuietTool === undefined
      ? toolCalls
      : toolCalls.filter((c) => !isQuietTool(c.name));
  const realCount = realCalls.length;

  const rawSummary = deriveSummary({
    parts,
    streaming,
    realCalls,
    summarizeCalls,
    formatSummary,
  });
  // Only debounce while streaming — a settled turn's summary is final and
  // must render immediately (no lag on hydration or turn-settle).
  const summary = useStableLabel(rawSummary, streaming);

  return (
    <div className={CHAT_ACTIVITY_STACK} data-testid="activity-block">
      <button
        type="button"
        disabled={streaming}
        onClick={() => {
          if (streaming) return;
          const next = !open;
          setSessionOverride(next);
          setExpanded?.(messageKey, next);
        }}
        aria-label={open ? "Hide activity" : "Show activity"}
        aria-expanded={open}
        className={cn(
          "relative flex self-start text-left",
          CHAT_TRACE_ROW,
          CHAT_TRACE_LABEL,
          "transition-[transform,color] duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
          streaming
            ? "cursor-default"
            : "hover:text-text-2 active:scale-[0.97] cursor-pointer",
          "after:absolute after:inset-0 after:-m-2 after:content-['']",
        )}
      >
        <span
          className={cn(
            CHAT_TRACE_MARKER_ALIGN,
            "flex items-center justify-center",
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
        <span
          className={cn(
            "flex min-w-0 items-center leading-snug",
            CHAT_TRACE_INLINE_GAP,
          )}
        >
          <RollingLabel label={summary} />
          {realCount > 0 && (
            <span
              className="shrink-0 text-text-3/70"
              data-testid="activity-count"
            >
              · {realCount} {realCount === 1 ? "tool" : "tools"}
            </span>
          )}
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "h-3 w-3 shrink-0 transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
              open && "rotate-90",
            )}
          />
        </span>
      </button>
      <Reveal open={open} reduceMotion={reduceMotion === true}>
        <div className={CHAT_RESPONSE_STACK} data-testid="activity-detail">
          {hasReasoning && (
            <div
              className={CHAT_TRACE_DETAIL_PANEL}
              data-testid="activity-reasoning"
            >
              <Markdown
                mode={streaming ? "streaming" : "static"}
                className={CHAT_TRACE_MUTED_BODY}
              >
                {reasoningText}
              </Markdown>
            </div>
          )}
          {toolCalls.length > 0 && (
            <ToolNarrative
              toolCalls={toolCalls}
              {...(formatSummary !== undefined ? { formatSummary } : {})}
              {...(formatResult !== undefined ? { formatResult } : {})}
              {...(summarizeCalls !== undefined ? { summarizeCalls } : {})}
              {...(isQuietTool !== undefined ? { isQuietTool } : {})}
              {...(isExternalTool !== undefined ? { isExternalTool } : {})}
              {...(renderToolMarker !== undefined ? { renderToolMarker } : {})}
              {...(onRespond !== undefined ? { onRespond } : {})}
              {...(onAction !== undefined ? { onAction } : {})}
            />
          )}
        </div>
      </Reveal>
    </div>
  );
}

function deriveSummary({
  parts,
  streaming,
  realCalls,
  summarizeCalls,
  formatSummary,
}: {
  parts: Part[];
  streaming: boolean;
  realCalls: ToolCall[];
  summarizeCalls?: ToolNarrativeProps["summarizeCalls"];
  formatSummary?: ToolNarrativeProps["formatSummary"];
}): string {
  if (streaming) {
    return deriveActivityLabel(parts, formatSummary);
  }
  if (realCalls.length > 0 && summarizeCalls !== undefined) {
    return summarizeCalls(realCalls);
  }
  if (realCalls.length > 0 && formatSummary !== undefined) {
    return formatSummary(realCalls[realCalls.length - 1]!);
  }
  return "Reasoning";
}
