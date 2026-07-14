import { useState } from "react";
import { cn } from "@workbench/ui";
import type { FeedbackSubjectKind } from "./feedback-types";

export interface MessageFeedbackProps {
  subjectId: string;
  subjectKind: FeedbackSubjectKind;
  /** Server-fetched rating for this subject; drives the displayed pressed state. */
  savedRating?: 1 | -1 | null;
  /** Called when the user selects a rating. Returns a promise; buttons are disabled while pending. */
  onRate: (
    subjectId: string,
    subjectKind: FeedbackSubjectKind,
    rating: 1 | -1,
  ) => Promise<void>;
}

export function MessageFeedback({
  subjectId,
  subjectKind,
  savedRating,
  onRate,
}: MessageFeedbackProps) {
  // Only the in-flight state is local. The displayed rating comes from `savedRating`
  // (server truth), switching to `optimisticRating` while the request is in flight
  // so the button feels immediately responsive.
  const [pending, setPending] = useState(false);
  const [optimisticRating, setOptimisticRating] = useState<1 | -1 | null>(null);
  const [failed, setFailed] = useState(false);

  const displayRating = pending ? optimisticRating : (savedRating ?? null);

  async function handleClick(next: 1 | -1) {
    if (pending) return;
    setPending(true);
    setOptimisticRating(next);
    setFailed(false);
    try {
      await onRate(subjectId, subjectKind, next);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  // Quiet by default: revealed on hover/focus of the turn (the `group` on
  // AgentTurn); always visible where hover doesn't exist. A saved rating
  // stays visible so the pressed thumb never disappears.
  const revealed = displayRating !== null || failed;

  return (
    <div
      className={cn(
        // gap must exceed the buttons' combined horizontal hit-area extension
        // (2 × after:-inset-x-1 = 8px) so the overlays never overlap — a click
        // near one thumb must not register on the other.
        "flex items-center gap-2.5 transition-opacity duration-150",
        revealed
          ? "opacity-100"
          : "opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100",
      )}
      aria-label="Rate this response"
    >
      {failed && <span className="text-xs text-red">Failed to save</span>}
      <button
        onClick={() => handleClick(1)}
        disabled={pending}
        aria-label="Thumbs up"
        aria-pressed={displayRating === 1}
        className={cn(FEEDBACK_BUTTON, displayRating === 1 && "text-orange")}
      >
        <ThumbUpIcon />
      </button>
      <button
        onClick={() => handleClick(-1)}
        disabled={pending}
        aria-label="Thumbs down"
        aria-pressed={displayRating === -1}
        className={cn(FEEDBACK_BUTTON, displayRating === -1 && "text-orange")}
      >
        <ThumbDownIcon />
      </button>
    </div>
  );
}

// Visual size stays small; the ::after overlay lifts the hit target to 44px
// vertically (tool-row TOUCH_TARGET pattern). Horizontal extension is held to
// 4px per side so adjacent thumbs' overlays cannot cross the row's 10px gap.
const FEEDBACK_BUTTON =
  "relative rounded p-1 text-text-3 transition-[color,transform] hover:text-text active:scale-[0.97] disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange cursor-pointer after:absolute after:-inset-x-1 after:-inset-y-2.5 after:content-['']";

function ThumbUpIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z" />
      <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
    </svg>
  );
}

function ThumbDownIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z" />
      <path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" />
    </svg>
  );
}
