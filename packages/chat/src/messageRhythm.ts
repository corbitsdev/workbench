/**
 * Shared spacing and typography for Myra / chat message surfaces.
 *
 * Vertical rhythm (repo-root DESIGN.md, --gap 14px), largest to smallest:
 *   - CHAT_THREAD_TURN_GAP (20px)  — between turns (ChatThread owns this only).
 *   - CHAT_TURN_STACK      (14px)  — between a turn's own sections: sender
 *     label, activity block (tool calls only, never reasoning-only — CL-3734),
 *     response bubble, trailing content, feedback. Also reused by
 *     `renderSettledAgentTurn` to space the (rare) multiple entries a
 *     projected group can carry — a block-bearing segment plus the final
 *     answer — at normal intra-turn rhythm; the common single-entry group
 *     never renders a gap (one child).
 *   - CHAT_RESPONSE_STACK  (14px)  — between paragraphs/blocks within one
 *     response (extracted prose + a UI block, activity tool rows). Reasoning
 *     no longer contributes a persistent row here (CL-3734) — process rows
 *     collapse to outputs-only as soon as a segment settles, live or not, so
 *     there is no leftover activity-block gap once a turn projects down to
 *     just its answer.
 *   - CHAT_TRACE_ROW gutter (14px) — marker-to-label gap on one trace row.
 *   - CHAT_ACTIVITY_STACK  (8px)   — activity block's own header-to-detail gap
 *     (tighter than CHAT_TURN_STACK: it is one disclosure, not two turn parts).
 *   - CHAT_TOOL_ROW_GAP    (20px)  — between sibling tool rows (sized for the
 *     rows' extended touch-target overlay; see ToolNarrative.tsx).
 *   - CHAT_TRACE_INLINE_GAP (6px)  — label/count/chevron within one row.
 *
 * Two indentation levels max: a trace row (marker + label) and its expanded
 * detail (CHAT_TRACE_DETAIL_OFFSET). Nothing nests deeper.
 */

/** 16px marker column (reasoning pulse, tool markers). */
export const CHAT_MARKER_SLOT = "h-4 w-4 shrink-0";

/** Marker + label on one process-trace row (14px gutter). */
export const CHAT_TRACE_ROW = "flex items-start gap-3.5";

/** Vertical stack inside a turn or trace block. */
export const CHAT_TURN_STACK = "flex w-full min-w-0 flex-col gap-3.5";

export const CHAT_TRACE_STACK = "flex flex-col gap-3.5";

/** Stack between paragraphs/blocks within one response (prose + UI block, reasoning + tools). */
export const CHAT_RESPONSE_STACK = "flex flex-col gap-3.5";

/** Activity block's header-to-detail gap — tighter than CHAT_TURN_STACK. */
export const CHAT_ACTIVITY_STACK = "flex w-full min-w-0 flex-col gap-2";

/** Label/count/chevron gap within one trace or activity-summary row. */
export const CHAT_TRACE_INLINE_GAP = "gap-1.5";

/** Marker vertical alignment against the first line of its label. */
export const CHAT_TRACE_MARKER_ALIGN = "mt-0.5";

/**
 * Left offset for nested trace detail (marker width + row gutter = 16px + 14px).
 */
export const CHAT_TRACE_DETAIL_OFFSET = "ml-[30px]";

/**
 * Bordered reasoning / tool expand panel. `min-w-0` + `overflow-wrap: anywhere`
 * so unbroken reasoning tokens wrap instead of widening the chat column (CL-4120).
 */
export const CHAT_TRACE_DETAIL_PANEL = `${CHAT_TRACE_DETAIL_OFFSET} min-w-0 [overflow-wrap:anywhere] border-l border-border pl-3.5`;

export const CHAT_TRACE_DETAIL_TOP = "mt-2";

/** Process trace labels (reasoning toggle, tool summary lines). */
export const CHAT_TRACE_LABEL = "text-sm leading-snug text-text-3";

/** Expanded reasoning and quiet meta-tool lines. */
export const CHAT_TRACE_MUTED_BODY = "text-xs leading-relaxed text-text-3";

/** Quiet meta-tool line — muted body, set apart as narration rather than a tool row. */
export const CHAT_TRACE_QUIET_BODY = `${CHAT_TRACE_MUTED_BODY} italic`;

/** Humanized tool-outcome text in an expanded row (one step lighter than reasoning). */
export const CHAT_TRACE_OUTCOME_BODY = "text-xs leading-relaxed text-text-2";

/** Settled assistant answer prose. */
export const CHAT_ASSISTANT_BODY = "w-full text-sm leading-relaxed text-text";

/** User bubble padding (standard md unit). */
export const CHAT_USER_BUBBLE_SURFACE =
  "max-w-[85%] rounded-lg px-3.5 py-2.5 text-sm break-words";

/** System notice bubble — same padding scale as user. */
export const CHAT_SYSTEM_BUBBLE_SURFACE =
  "max-w-[85%] rounded-lg px-3.5 py-2.5 text-sm break-words bg-surface-2 text-text-3 italic";

/** Message column padding in the scrollable thread. */
export const CHAT_THREAD_PADDING = "p-3.5";

/** Space between turns (lg / 20px). */
export const CHAT_THREAD_TURN_GAP = "gap-5";

/** Timestamp / sender / status meta line (From:, Sending…, busy label). */
export const CHAT_META_TEXT = "text-xs text-text-3";

/** Meta line in its error state (Failed to send, Couldn't download). */
export const CHAT_META_ERROR_TEXT = "text-xs text-red";
