import { useState, type ReactNode } from "react";
import { cn, toHumanLabel } from "@workbench/ui";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { ToolCall } from "./types";
import {
  parseToolResult,
  UIBlockView,
  type UIBlock,
  type UIResponse,
} from "@workbench/blocks";

function ErrorIcon() {
  return (
    <span
      data-testid="tool-marker-error"
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-red-500"
    >
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
    </span>
  );
}

function BulletIcon() {
  return (
    <span
      data-testid="tool-marker-bullet"
      className="flex h-4 w-4 shrink-0 items-center justify-center"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-text-3" />
    </span>
  );
}

// Settled marker: errors keep a loud badge; external tools get a quiet bullet;
// internal tools get an empty slot (plain text, but rows stay column-aligned).
function SettledMarker({
  isError,
  external,
}: {
  isError: boolean;
  external: boolean;
}) {
  if (isError) return <ErrorIcon />;
  if (external) return <BulletIcon />;
  return <span className="h-4 w-4 shrink-0" aria-hidden="true" />;
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
   * Optional formatter the host supplies to turn a tool name + args into a
   * human-readable action phrase. Falls back to the call's `label` or a
   * humanized name. When set, pending rows use it too (never the raw tool id).
   */
  formatSummary?: (call: ToolCall) => string;
  /**
   * Optional formatter for the settled outcome of a tool call. When provided,
   * the expandable body shows this short human line instead of dumping raw
   * JSON args/results. Structured UI blocks still render when parseable.
   * Return null to fall back (errors still surface their message).
   */
  formatResult?: (call: ToolCall) => string | null;
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
  /**
   * Platform-internal tools (e.g. search_tools / load_tools) render as quiet
   * reasoning-style text — no checkmark, no expand chrome — and are excluded
   * from the collapsed "N tools" count.
   */
  isQuietTool?: (name: string) => boolean;
  /**
   * External integration tools (provider-prefixed, e.g. `attio__create_note`)
   * get a small bullet marker when settled; internal tools render plain.
   * When omitted, every non-quiet tool is treated as external.
   */
  isExternalTool?: (name: string) => boolean;
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

function QuietToolLine({ summary }: { summary: string }) {
  return (
    <p
      className="text-xs italic leading-snug text-text-3/80"
      data-testid="quiet-tool-line"
    >
      {summary}
    </p>
  );
}

function ToolRow({
  call,
  summary,
  quiet,
  external,
  suppressArgsSummary,
  formatResult,
  onRespond,
  onAction,
}: {
  call: ToolCall;
  summary: string;
  quiet: boolean;
  external: boolean;
  // When the host supplies a formatter, the summary line already conveys the
  // relevant argument (e.g. "Searching the web for X"), so the raw arg chip
  // would render it twice. The full arguments remain available on expand only
  // when formatResult is not also suppressing raw dumps.
  suppressArgsSummary: boolean;
  formatResult?: ((call: ToolCall) => string | null) | undefined;
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
  const humanized = formatResult !== undefined;
  const friendlyOutcome =
    !pending && formatResult !== undefined ? formatResult(call) : null;
  const hasFriendly = friendlyOutcome !== null && friendlyOutcome.trim() !== "";
  const resultBlock =
    call.result !== undefined && call.result !== "" && !call.isError
      ? parseToolResult(call.result)
      : null;
  // Structured interactive blocks (form/document/…) stay available even when
  // the host humanizes outcomes. Plain `text` blocks are raw dumps in practice
  // (parseToolResult wraps any non-UIBlock string) and only show in legacy mode.
  const structuredBlock =
    resultBlock !== null && resultBlock.kind !== "text" ? resultBlock : null;
  // Humanized mode: expand for a friendly outcome, structured UI, or an error
  // message — never for raw JSON dumps. Legacy mode keeps the previous contract.
  const expandable = humanized
    ? !pending &&
      (hasFriendly ||
        structuredBlock !== null ||
        (call.isError === true &&
          call.result !== undefined &&
          call.result !== ""))
    : !pending && (call.result !== undefined || hasArgs);

  // Internal meta-tools: quiet reasoning-style text, no tool chrome.
  if (quiet) {
    return <QuietToolLine summary={summary} />;
  }

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
            <SettledMarker
              isError={call.isError === true}
              external={external}
            />
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
          {humanized ? (
            <>
              {structuredBlock !== null && (
                <div className="text-sm">
                  <UIBlockView
                    block={structuredBlock}
                    {...(onRespond !== undefined ? { onRespond } : {})}
                    {...(onAction !== undefined ? { onAction } : {})}
                  />
                </div>
              )}
              {structuredBlock === null && hasFriendly && (
                <p
                  className={cn(
                    "leading-relaxed",
                    call.isError === true ? "text-red-600" : "text-text-2",
                  )}
                >
                  {friendlyOutcome}
                </p>
              )}
              {structuredBlock === null &&
                !hasFriendly &&
                call.isError === true &&
                call.result !== undefined &&
                call.result !== "" && (
                  <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-red-500/10 px-2 py-1.5 font-mono text-red-600">
                    {call.result}
                  </pre>
                )}
            </>
          ) : (
            <>
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
            </>
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
  formatResult,
  isQuietTool,
  isExternalTool,
  onRespond,
  onAction,
}: Pick<
  ToolNarrativeProps,
  | "toolCalls"
  | "formatSummary"
  | "formatResult"
  | "isQuietTool"
  | "isExternalTool"
  | "onRespond"
  | "onAction"
>) {
  const fmt = formatSummary ?? defaultSummary;
  return (
    <>
      {toolCalls.map((call) => (
        <ToolRow
          key={call.id}
          call={call}
          summary={fmt(call)}
          quiet={isQuietTool?.(call.name) === true}
          external={isExternalTool === undefined || isExternalTool(call.name)}
          suppressArgsSummary={formatSummary !== undefined}
          {...(formatResult !== undefined ? { formatResult } : {})}
          {...(onRespond !== undefined ? { onRespond } : {})}
          {...(onAction !== undefined ? { onAction } : {})}
        />
      ))}
    </>
  );
}

function CollapsedToolSummary({
  summary,
  count,
  hasError,
  external,
  children,
}: {
  summary: string;
  count: number;
  hasError: boolean;
  external: boolean;
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
          <SettledMarker isError={hasError} external={external} />
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
  formatResult,
  compact,
  summarizeCalls,
  isQuietTool,
  isExternalTool,
  onRespond,
  onAction,
  className,
}: ToolNarrativeProps) {
  if (toolCalls.length === 0) return null;

  const realCalls =
    isQuietTool === undefined
      ? toolCalls
      : toolCalls.filter((c) => !isQuietTool(c.name));
  const quietCalls =
    isQuietTool === undefined
      ? []
      : toolCalls.filter((c) => isQuietTool(c.name));

  const anyPending = toolCalls.some(
    (c) => c.result === undefined && c.isError !== true,
  );
  // Collapse only considers real (non-quiet) tools — meta-tools never pad the count.
  const shouldCollapse =
    compact === true &&
    summarizeCalls !== undefined &&
    !anyPending &&
    realCalls.length >= COLLAPSE_THRESHOLD;

  const quietRows =
    quietCalls.length === 0 ? null : (
      <ToolRows
        toolCalls={quietCalls}
        {...(formatSummary !== undefined ? { formatSummary } : {})}
        {...(isQuietTool !== undefined ? { isQuietTool } : {})}
      />
    );

  const realRows =
    realCalls.length === 0 ? null : (
      <ToolRows
        toolCalls={realCalls}
        {...(formatSummary !== undefined ? { formatSummary } : {})}
        {...(formatResult !== undefined ? { formatResult } : {})}
        {...(isQuietTool !== undefined ? { isQuietTool } : {})}
        {...(isExternalTool !== undefined ? { isExternalTool } : {})}
        {...(onRespond !== undefined ? { onRespond } : {})}
        {...(onAction !== undefined ? { onAction } : {})}
      />
    );

  return (
    <div className={cn(ROW_GAP, className)} data-testid="tool-narrative">
      {quietRows}
      {shouldCollapse ? (
        <CollapsedToolSummary
          summary={summarizeCalls(realCalls)}
          count={realCalls.length}
          hasError={realCalls.some((c) => c.isError === true)}
          external={realCalls.some(
            (c) => isExternalTool === undefined || isExternalTool(c.name),
          )}
        >
          {realRows}
        </CollapsedToolSummary>
      ) : (
        realRows
      )}
    </div>
  );
}
