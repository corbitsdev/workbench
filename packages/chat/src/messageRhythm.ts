/**
 * Shared spacing and typography for Myra / chat message surfaces.
 * Values follow DESIGN.md (--gap 14px): prefer gap-3.5 / p-3.5 for standard rhythm.
 */

/** 16px marker column (reasoning pulse, tool markers). */
export const CHAT_MARKER_SLOT = "h-4 w-4 shrink-0";

/** Marker + label on one process-trace row (14px gutter). */
export const CHAT_TRACE_ROW = "flex items-start gap-3.5";

/** Vertical stack inside a turn or trace block. */
export const CHAT_TURN_STACK = "flex w-full flex-col gap-3.5";

export const CHAT_TRACE_STACK = "flex flex-col gap-3.5";

/**
 * Left offset for nested trace detail (marker width + row gutter = 16px + 14px).
 */
export const CHAT_TRACE_DETAIL_OFFSET = "ml-[30px]";

/** Bordered reasoning / tool expand panel. */
export const CHAT_TRACE_DETAIL_PANEL = `${CHAT_TRACE_DETAIL_OFFSET} border-l border-border pl-3.5`;

export const CHAT_TRACE_DETAIL_TOP = "mt-2";

/** Process trace labels (reasoning toggle, tool summary lines). */
export const CHAT_TRACE_LABEL =
  "text-sm leading-snug text-text-3";

/** Expanded reasoning and quiet meta-tool lines. */
export const CHAT_TRACE_MUTED_BODY =
  "text-xs leading-relaxed text-text-3";

/** Settled assistant answer prose. */
export const CHAT_ASSISTANT_BODY =
  "w-full text-sm leading-relaxed text-text";

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