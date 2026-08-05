import { type } from "arktype";
import { useEffect, useState } from "react";

export const QuoteSchema = type({
  quote: "string",
  "author?": "string",
});
export type Quote = typeof QuoteSchema.infer;

/** Rotated through the auth brand panel. Edit freely. */
const QUOTES: readonly Quote[] = [
  {
    quote: "Stop prompting and start operating with your AI Workbench.",
    author: "Corbits",
  },
  {
    quote: "The best interface for an agent is the one you already trust.",
    author: "Corbits",
  },
  {
    quote: "Ship the workflow, not the transcript.",
    author: "Corbits",
  },
  {
    quote: "An approval you can see is an agent you can delegate to.",
    author: "Corbits",
  },
];

const STORAGE_KEY = "cw-quote-index";

// The persisted index crosses an untrusted boundary (localStorage), so it is
// validated rather than cast. Anything not a non-negative integer falls back to
// -1, which advances to the first quote.
const StoredIndex = type("string.integer.parse").to("number >= 0");

/** Last shown index, or -1 if none is validly stored. */
function lastIndex(): number {
  try {
    const parsed = StoredIndex(localStorage.getItem(STORAGE_KEY));
    return parsed instanceof type.errors ? -1 : parsed;
  } catch {
    return -1;
  }
}

/** Next index in the rotation, derived from the last one shown. */
function nextIndex(): number {
  return (lastIndex() + 1) % QUOTES.length;
}

/**
 * Brand quote card. Advances to the next quote once per page load (persisted in
 * localStorage) — it does not cycle while the page is open.
 */
export function QuoteCard() {
  const [index] = useState(nextIndex);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(index));
    } catch {
      // localStorage unavailable (private mode / blocked) — rotation just
      // restarts from the first quote next load.
    }
  }, [index]);

  const current = QUOTES[index % QUOTES.length];
  if (current === undefined) return null;

  return (
    <div className="auth-quote-overlay">
      <div className="auth-quote-card">
        <blockquote className="auth-quote-text">
          &ldquo;{current.quote}&rdquo;
        </blockquote>
        {current.author !== undefined && (
          <div className="auth-quote-attr">
            <div className="auth-quote-attr-rule" />
            <span className="auth-quote-attr-name">{current.author}</span>
          </div>
        )}
      </div>
    </div>
  );
}
