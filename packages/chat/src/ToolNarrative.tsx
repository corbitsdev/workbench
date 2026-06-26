import { useState, type ReactNode } from "react";
import { cn, toHumanLabel } from "@workbench/ui";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { ToolCall } from "./types";
import { parseToolResult, type UIBlock, type UIResponse } from "./ui-block";
import { UIBlockView } from "./UIBlockView";

function DoneIcon({ isError }: { isError?: boolean }) {
  return (
    <span
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
        isError ? "bg-red-500" : "bg-text-3",
      )}
    >
      {isError ? (
        <svg
          className="h-2.5 w-2.5 text-white"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={4}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      ) : (
        <svg
          className="h-2.5 w-2.5 text-white"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={4}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </span>
  );
}

function ActiveIcon() {
  const reduceMotion = useReducedMotion();
  return (
    <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
      {reduceMotion !== true && (
        <motion.span
          aria-hidden="true"
          className="absolute inline-flex h-full w-full rounded-full bg-orange"
          // Transform + opacity only, so the pulse stays on the compositor; a
          // constant repeating pulse reads best with a linear ease.
          animate={{ scale: [1, 1.6, 1], opacity: [0.6, 0, 0.6] }}
          transition={{ repeat: Infinity, duration: 1.4, ease: "linear" }}
        />
      )}
      <span className="relative inline-flex h-2 w-2 rounded-full bg-orange" />
    </span>
  );
}

// Below this count there is no benefit to collapsing — the flat list is short
// and more informative than a roll-up sentence.
const COLLAPSE_THRESHOLD = 3;

// Brand ease-out (DESIGN.md), shared with ReasoningDisclosure: snappy settle for
// small disclosures.
const EASE_OUT = [0.23, 1, 0.32, 1] as const;

// Dense rows are visually short (~20px). A transparent inset overlay lifts the
// tap target to ~40px without inflating the row's layout height. The 10px inset
// is held at exactly half the 20px inter-row gap (`ROW_GAP`/`space-y-5`) so
// adjacent overlays meet at the gap midpoint instead of overlapping.
const TOUCH_TARGET =
  "relative after:absolute after:inset-x-0 after:-inset-y-2.5 after:content-['']";

// Inter-row spacing for interactive lists; sized so the `TOUCH_TARGET` overlay
// can reach a ~40px tap target without colliding with neighbours.
const ROW_GAP = "space-y-5";

export interface ToolNarrativeProps {
  toolCalls: ToolCall[];
  /**
   * Optional formatter the host supplies to turn a tool name + result into a
   * human-readable summary line. Falls back to the call's `label` or `name`.
   */
  formatSummary?: (call: ToolCall) => string;
  /**
   * When true (and a `summarizeCalls` is supplied), a completed turn with
   * {@link COLLAPSE_THRESHOLD}+ tool calls collapses into a single summary line
   * that expands on click. A turn still in flight always shows the live list.
   */
  compact?: boolean;
  /**
   * Rolls the whole turn's calls into one summary line for the collapsed view,
   * e.g. "Searched Attio 6×, read 5 notes, and checked Linear 2×".
   */
  summarizeCalls?: (calls: ToolCall[]) => string;
  /** Forwarded to interactive UI blocks rendered from a structured tool result. */
  onRespond?: (response: UIResponse) => void;
  /** Forwarded to document UI blocks for copy / download / save-artifact. */
  onAction?: (
    action: "copy" | "download" | "save-artifact",
    block: UIBlock,
  ) => void;
  className?: string;
}

function defaultSummary(call: ToolCall): string {
  if (call.label !== undefined) return call.label;
  // Anthropic raw call IDs look like "call_01_AbCdEf…" — not readable
  if (/^call_[0-9A-Za-z_]{10,}$/.test(call.name)) return "Tool call";
  return toHumanLabel(call.name);
}

// A concise, human-readable summary of what the tool was invoked with, e.g.
// the search query, so the narrative shows "exa search · minimax m3" rather
// than a bare label.
function summarizeArgs(args?: Record<string, unknown>): string | null {
  if (args === undefined) return null;
  const keys = Object.keys(args);
  if (keys.length === 0) return null;
  for (const key of ["query", "q", "url", "prompt", "text", "path", "name"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  for (const key of keys) {
    const value = args[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return `${key}: ${String(value)}`;
    }
  }
  return null;
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={cn(
        "h-3 w-3 shrink-0 text-text-3 transition-transform",
        open && "rotate-90",
      )}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function ToolRow({
  call,
  summary,
  suppressArgsSummary,
  onRespond,
  onAction,
}: {
  call: ToolCall;
  summary: string;
  // When the host supplies a formatter, the summary line already conveys the
  // relevant argument (e.g. "Searching the web for X"), so the raw arg chip
  // would render it twice. The full arguments remain available on expand.
  suppressArgsSummary: boolean;
  onRespond?: ((response: UIResponse) => void) | undefined;
  onAction?:
    | ((action: "copy" | "download" | "save-artifact", block: UIBlock) => void)
    | undefined;
}) {
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const pending = call.result === undefined && !call.isError;
  const argsSummary = suppressArgsSummary
    ? null
    : summarizeArgs(call.arguments);
  const hasArgs =
    call.arguments !== undefined && Object.keys(call.arguments).length > 0;
  const expandable = !pending && (call.result !== undefined || hasArgs);
  const resultBlock =
    call.result !== undefined && call.result !== "" && !call.isError
      ? parseToolResult(call.result)
      : null;

  return (
    <div className="flex flex-col">
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-start gap-2.5 text-left",
          expandable && cn("cursor-pointer", TOUCH_TARGET),
        )}
      >
        <span className="mt-0.5">
          {pending ? (
            <ActiveIcon />
          ) : (
            <DoneIcon isError={call.isError === true} />
          )}
        </span>
        <span
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-sm leading-snug",
            pending
              ? "text-text-2"
              : call.isError
                ? "text-red-600"
                : "text-text-3",
          )}
        >
          <span className="shrink-0">{summary}</span>
          {argsSummary !== null && (
            <span className="truncate text-text-3/70">· {argsSummary}</span>
          )}
          {expandable && <ChevronIcon open={open} />}
        </span>
      </button>
      <ExpandReveal open={open} reduceMotion={reduceMotion === true}>
        <div className="mt-1.5 ml-[26px] space-y-2 text-xs">
          {hasArgs && (
            <pre className="overflow-x-auto rounded bg-surface-2 px-2 py-1.5 font-mono text-text-2">
              {JSON.stringify(call.arguments, null, 2)}
            </pre>
          )}
          {call.isError === true &&
            call.result !== undefined &&
            call.result !== "" && (
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-red-500/10 px-2 py-1.5 font-mono text-red-600">
                {call.result}
              </pre>
            )}
          {resultBlock !== null && resultBlock.kind === "text" && (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-2 px-2 py-1.5 font-mono text-text-2">
              {resultBlock.text}
            </pre>
          )}
          {resultBlock !== null && resultBlock.kind !== "text" && (
            <div className="text-sm">
              <UIBlockView
                block={resultBlock}
                {...(onRespond !== undefined ? { onRespond } : {})}
                {...(onAction !== undefined ? { onAction } : {})}
              />
            </div>
          )}
        </div>
      </ExpandReveal>
    </div>
  );
}

// Smooth height/opacity reveal for expand/collapse content, matched to the
// chevron's timing. Honors reduced-motion by toggling without animating.
function ExpandReveal({
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
          key="reveal"
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

function ToolRows({
  toolCalls,
  formatSummary,
  onRespond,
  onAction,
}: Pick<
  ToolNarrativeProps,
  "toolCalls" | "formatSummary" | "onRespond" | "onAction"
>) {
  const fmt = formatSummary ?? defaultSummary;
  return (
    <>
      {toolCalls.map((call) => {
        const pending = call.result === undefined && !call.isError;
        const summary = pending ? (call.label ?? call.name) : fmt(call);
        return (
          <ToolRow
            key={call.id}
            call={call}
            summary={summary}
            suppressArgsSummary={formatSummary !== undefined}
            onRespond={onRespond}
            onAction={onAction}
          />
        );
      })}
    </>
  );
}

function CollapsedToolSummary({
  summary,
  count,
  hasError,
  children,
}: {
  summary: string;
  count: number;
  hasError: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "flex items-start gap-2.5 text-left cursor-pointer",
          TOUCH_TARGET,
        )}
      >
        <span className="mt-0.5">
          <DoneIcon isError={hasError} />
        </span>
        <span
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-sm leading-snug",
            hasError ? "text-red-600" : "text-text-3",
          )}
        >
          <span className="min-w-0 truncate">{summary}</span>
          <span className="shrink-0 text-text-3/70">· {count} tools</span>
          <ChevronIcon open={open} />
        </span>
      </button>
      <ExpandReveal open={open} reduceMotion={reduceMotion === true}>
        <div className={cn("mt-1.5", ROW_GAP)}>{children}</div>
      </ExpandReveal>
    </div>
  );
}

export function ToolNarrative({
  toolCalls,
  formatSummary,
  compact,
  summarizeCalls,
  onRespond,
  onAction,
  className,
}: ToolNarrativeProps) {
  if (toolCalls.length === 0) return null;

  const anyPending = toolCalls.some(
    (c) => c.result === undefined && c.isError !== true,
  );
  const shouldCollapse =
    compact === true &&
    summarizeCalls !== undefined &&
    !anyPending &&
    toolCalls.length >= COLLAPSE_THRESHOLD;

  const rows = (
    <ToolRows
      toolCalls={toolCalls}
      {...(formatSummary !== undefined ? { formatSummary } : {})}
      {...(onRespond !== undefined ? { onRespond } : {})}
      {...(onAction !== undefined ? { onAction } : {})}
    />
  );

  return (
    <div className={cn(ROW_GAP, className)} data-testid="tool-narrative">
      {shouldCollapse ? (
        <CollapsedToolSummary
          summary={summarizeCalls(toolCalls)}
          count={toolCalls.length}
          hasError={toolCalls.some((c) => c.isError === true)}
        >
          {rows}
        </CollapsedToolSummary>
      ) : (
        rows
      )}
    </div>
  );
}
