import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { cn, Markdown } from "@workbench/ui";
import type { ToolCall } from "./types";
import { ToolNarrative, type ToolNarrativeProps } from "./ToolNarrative";
import { rollingReasoningLabel } from "./reasoning-summary";
import {
  CHAT_MARKER_SLOT,
  CHAT_TRACE_DETAIL_PANEL,
  CHAT_TRACE_LABEL,
  CHAT_TRACE_MUTED_BODY,
  CHAT_TRACE_ROW,
} from "./messageRhythm";

// Brand ease-out (repo-root DESIGN.md), shared with the tool/reasoning reveals.
const EASE_OUT = [0.23, 1, 0.32, 1] as const;

export interface ActivityBlockProps {
  /** Raw cumulative reasoning text for the turn (may be empty). */
  reasoning: string;
  /** Tool calls for the turn, already filtered by the host's hide predicate. */
  toolCalls: ToolCall[];
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
 * A single collapsible block gathering ALL of one turn's process activity —
 * reasoning trace and tool calls — above the answer (CL-3637). Collapsed by
 * default with a one-line summary; the same structure renders whether the turn
 * is streaming live or loaded from a finished thread, so there is no divergent
 * "live" vs "historical" path.
 *
 * The collapsed summary rolls in place while streaming (latest meaningful
 * reasoning step, low-signal narration filtered — CL-3638); settled turns show
 * a roll-up of what happened. Tool rows render through the single ToolNarrative
 * treatment (CL-3639).
 */
export function ActivityBlock({
  reasoning,
  toolCalls,
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
  const open = sessionOverride ?? persisted;

  const hasReasoning = reasoning.trim() !== "";
  const realCalls =
    isQuietTool === undefined
      ? toolCalls
      : toolCalls.filter((c) => !isQuietTool(c.name));
  const hasError = realCalls.some((c) => c.isError === true);
  const realCount = realCalls.length;

  const summary = deriveSummary({
    reasoning,
    streaming,
    realCalls,
    summarizeCalls,
    formatSummary,
  });

  return (
    <div className="flex w-full flex-col gap-2" data-testid="activity-block">
      <button
        type="button"
        onClick={() => {
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
          "hover:text-text-2 active:scale-[0.97] cursor-pointer",
          "after:absolute after:inset-0 after:-m-2 after:content-['']",
        )}
      >
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
          <span
            className={cn("min-w-0 truncate", hasError && "text-red")}
            data-testid="activity-summary"
          >
            {summary}
          </span>
          {realCount > 0 && (
            <span className="shrink-0 text-text-3/70" data-testid="activity-count">
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
        <div className="flex flex-col gap-3.5" data-testid="activity-detail">
          {hasReasoning && (
            <div className={CHAT_TRACE_DETAIL_PANEL} data-testid="activity-reasoning">
              <Markdown
                mode={streaming ? "streaming" : "static"}
                className={CHAT_TRACE_MUTED_BODY}
              >
                {reasoning}
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
  reasoning,
  streaming,
  realCalls,
  summarizeCalls,
  formatSummary,
}: {
  reasoning: string;
  streaming: boolean;
  realCalls: ToolCall[];
  summarizeCalls?: ToolNarrativeProps["summarizeCalls"];
  formatSummary?: ToolNarrativeProps["formatSummary"];
}): string {
  if (streaming) {
    const label = rollingReasoningLabel(reasoning);
    if (label !== null) return label;
    const pending = [...realCalls]
      .reverse()
      .find((c) => c.result === undefined && c.isError !== true);
    if (pending !== undefined && formatSummary !== undefined) {
      return formatSummary(pending);
    }
    return "Working";
  }
  if (realCalls.length > 0 && summarizeCalls !== undefined) {
    return summarizeCalls(realCalls);
  }
  if (realCalls.length > 0 && formatSummary !== undefined) {
    return formatSummary(realCalls[realCalls.length - 1]!);
  }
  return "Reasoning";
}
