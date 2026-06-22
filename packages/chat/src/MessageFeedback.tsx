import { useState } from 'react';
import { cn } from '@workbench/ui';
import type { FeedbackSubjectKind } from './feedback-types';

export interface MessageFeedbackProps {
  subjectId: string;
  subjectKind: FeedbackSubjectKind;
  /** Called when the user selects a rating. Returns a promise; buttons are disabled while pending. */
  onRate: (subjectId: string, subjectKind: FeedbackSubjectKind, rating: 1 | -1) => Promise<void>;
}

export function MessageFeedback({ subjectId, subjectKind, onRate }: MessageFeedbackProps) {
  const [rating, setRating] = useState<1 | -1 | null>(null);
  const [pending, setPending] = useState(false);

  async function handleClick(next: 1 | -1) {
    if (pending) return;
    setPending(true);
    try {
      await onRate(subjectId, subjectKind, next);
      setRating(next);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-center gap-1 mt-1" aria-label="Rate this response">
      <button
        onClick={() => handleClick(1)}
        disabled={pending}
        aria-label="Thumbs up"
        aria-pressed={rating === 1}
        className={cn(
          'rounded p-1 text-text-3 transition-colors hover:text-text disabled:cursor-not-allowed',
          rating === 1 && 'text-orange'
        )}
      >
        <ThumbUpIcon />
      </button>
      <button
        onClick={() => handleClick(-1)}
        disabled={pending}
        aria-label="Thumbs down"
        aria-pressed={rating === -1}
        className={cn(
          'rounded p-1 text-text-3 transition-colors hover:text-text disabled:cursor-not-allowed',
          rating === -1 && 'text-orange'
        )}
      >
        <ThumbDownIcon />
      </button>
    </div>
  );
}

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
