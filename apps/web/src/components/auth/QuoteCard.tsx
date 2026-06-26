import { useState } from "react";
import { type } from "arktype";
import { useMountEffect } from "../../hooks/use-mount-effect";

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
  { quote: "I'm not going to defend any more of my own output today." },
  {
    quote:
      "99 fixups across 23 feature commits is ~4 bugs per feature commit, on average. That's not quality. That's a shame-shaped history.",
  },
  { quote: "BREAKING: CEO discovers tokens cost money." },
  { quote: "Fable 5 lies 96% of the time. We were surprised by its skill." },
  { quote: "Extra guac = longer context window" },
  {
    quote: [
      "PICARD: Data, shields up",
      "DATA: Brilliant! Shields can reduce damage we sustain...",
      "[camera shakes]",
      "WORF: HULL BREACHES ON NINE DECKS",
      "DATA: Here's what happened: you told me to raise shields, and I didn't",
    ].join("\n"),
  },
  {
    quote:
      `Frog put Claude in a box. "There," he said. "Now he cannot run rm -rf /." ` +
      `But he can run bash -c 'rm -rf /', said Toad. That is true, said Frog.`,
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

  useMountEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(index));
    } catch {
      // localStorage unavailable (private mode / blocked) — rotation just
      // restarts from the first quote next load.
    }
  });

  const current = QUOTES[index % QUOTES.length];

  return (
    <div className="absolute inset-0 flex items-center justify-center p-12">
      <div className="w-full max-w-xs rounded-xl border border-border bg-surface/90 p-6 shadow-[var(--shadow)] backdrop-blur-sm">
        <blockquote className="whitespace-pre-line text-base leading-relaxed text-text">
          &ldquo;{current.quote}&rdquo;
        </blockquote>
        {current.author && (
          <div className="mt-4 flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-text-3">{current.author}</span>
          </div>
        )}
      </div>
    </div>
  );
}
