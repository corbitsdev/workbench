// Renders the recent workbench timeline into a plain-text block prepended
// to a mention fan-out copy, so a mentioned agent sees the conversation
// it is being dropped into rather than only the single message
// addressing it. Kept as a pure formatter, separate from the mail
// loading/decoding it consumes in `routes.ts`'s POST message handler:
// this module never touches `ChatPlatform` or mail shapes, only the
// already-decoded `{ label, text }` pairs the caller assembles.

const CONTEXT_HEADER =
  "[Workbench context — the most recent messages in this workbench, oldest " +
  "first. The actual message addressed to you follows after this block.]";

/** Per-message truncation length; long messages are summarized to their
 * lead rather than blown out in full, keeping the block scannable. */
const MAX_MESSAGE_LENGTH = 500;

/**
 * Upper bound on how many of the most recent dropped messages the
 * caller should even look at when building a recap — see
 * `buildDroppedRecap`. Keeps the recap's own cost bounded regardless of
 * how far back a workbench's history goes; anything older than this is
 * never inspected, only counted as "possibly more" via
 * `moreBeyondFold`.
 */
export const DROPPED_RECAP_LOOKBACK = 60;

/** Per-message lead length folded into a recap, and the recap's own
 * total character budget — both deliberately far below
 * `MAX_MESSAGE_LENGTH`, since a recap stands in for many messages at
 * once rather than rendering one. */
const DROPPED_LEAD_LENGTH = 100;
const DROPPED_FOLD_CHAR_BUDGET = 1200;

/** The recap's sender label: system-ish framing, matching the
 * `label: text` shape every other context line renders as, but never
 * attributable to a real person or agent. */
const RECAP_LABEL = "system";

function formatRecapDate(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? iso
    : parsed.toISOString().slice(0, 10);
}

export interface DroppedRecapInput {
  /** Total messages the context window dropped, capped to what the
   * caller actually looked at (at most `DROPPED_RECAP_LOOKBACK`). */
  readonly droppedCount: number;
  /** True when the dropped span continues further back than the
   * caller chose to look — the count and fold tail are then marked as
   * a lower bound rather than claiming an exact total. */
  readonly moreBeyondFold: boolean;
  readonly firstDate?: string;
  readonly lastDate?: string;
  /** The dropped span's HUMAN messages, oldest first, already capped
   * to `DROPPED_RECAP_LOOKBACK` — agents' replies are derivative, so
   * only human messages carry facts worth folding in. */
  readonly humanTexts: readonly string[];
}

/**
 * Builds the one synthetic context entry that stands in for a
 * workbench-context window's dropped history — deterministic v1, no LLM
 * summarization: a bounded fold of each dropped human message's first
 * ~100 chars, oldest first, capped at ~1200 chars total with an honest
 * "… and N more" tail for whatever didn't fit or wasn't even looked at.
 * Never exceeds its own cap regardless of how much history it is
 * standing in for.
 */
export function buildDroppedRecap(
  input: DroppedRecapInput,
): WorkbenchContextItem {
  const countLabel = `${input.droppedCount}${input.moreBeyondFold ? "+" : ""}`;
  const dateRange =
    input.firstDate !== undefined && input.lastDate !== undefined
      ? `, from ${formatRecapDate(input.firstDate)} to ${formatRecapDate(input.lastDate)}`
      : "";

  const leads: string[] = [];
  let used = 0;
  for (const text of input.humanTexts) {
    const lead = text.slice(0, DROPPED_LEAD_LENGTH);
    const addition = (leads.length === 0 ? 0 : 2) + lead.length;
    if (used + addition > DROPPED_FOLD_CHAR_BUDGET) break;
    leads.push(lead);
    used += addition;
  }
  const omittedHuman = input.humanTexts.length - leads.length;
  const moreTail =
    omittedHuman > 0
      ? ` … and ${omittedHuman}${input.moreBeyondFold ? "+" : ""} more`
      : input.moreBeyondFold
        ? " … and possibly more"
        : "";
  const body =
    leads.length > 0 ? leads.join("; ") : "(no human messages in this span)";

  return {
    label: RECAP_LABEL,
    text:
      `Earlier in this conversation (${countLabel} older messages${dateRange}): ` +
      `${body}${moreTail}`,
  };
}

export interface WorkbenchContextItem {
  /**
   * The sender label to render a message under: `@handle` for an agent
   * participant, or the literal string `"user"` for anything else. Never
   * a raw address or principal id — this text reaches a model prompt and
   * possibly logs.
   */
  readonly label: string;
  readonly text: string;
}

function truncate(text: string): string {
  return text.length > MAX_MESSAGE_LENGTH
    ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…`
    : text;
}

/**
 * Renders a plain-text workbench context block from oldest-first text
 * messages. Purely a formatter: the caller is responsible for excluding
 * event-kind parts and the just-sent message, for capping `items` to
 * the workbench's resolved context-window size before calling, and for
 * skipping the call entirely when `items` is empty (a zero-context send
 * carries no context part at all, identical to today's fan-out copy).
 */
export function renderWorkbenchContext(input: {
  readonly items: readonly WorkbenchContextItem[];
  /**
   * The dropped-history recap (see `buildDroppedRecap`), prepended
   * right after the header, ahead of every kept item. Rendered
   * verbatim, bypassing the per-item `truncate` below: it already
   * enforces its own tighter cap and stands for many messages at once,
   * not just the one `truncate` sizes for.
   */
  readonly recap?: WorkbenchContextItem;
}): string {
  const lines = input.items.map(
    (item) => `${item.label}: ${truncate(item.text)}`,
  );
  const recapLine =
    input.recap !== undefined
      ? [`${input.recap.label}: ${input.recap.text}`]
      : [];
  return [CONTEXT_HEADER, ...recapLine, ...lines].join("\n");
}

/**
 * Merges a rendered context block into a message's first text part —
 * never as a part of its own. A second part turns the fan-out copy
 * into multipart MIME, and the agent-side mail parser at the current
 * platform version fails the whole run on multipart bodies (the same
 * defect family scripts/repro/WALKPARTS.md documents on the read
 * side); one text part keeps the copy a single text/plain body. A
 * message with no text part gets the context as its leading text part
 * instead — there is nothing to merge into.
 */
export function mergeContextIntoParts<T extends { kind: string }>(
  contextText: string,
  parts: readonly T[],
): readonly (T | { kind: "text"; text: string })[] {
  const firstTextAt = parts.findIndex((part) => part.kind === "text");
  if (firstTextAt === -1) {
    return [{ kind: "text", text: contextText }, ...parts];
  }
  return parts.map((part, index) =>
    index === firstTextAt
      ? {
          kind: "text",
          text: `${contextText}\n\n${(part as T & { text: string }).text}`,
        }
      : part,
  );
}
