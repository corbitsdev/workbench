// Turns the first message into a short sidebar title so an ad-hoc bench
// gets the same naming treatment as a prefab template, via the existing
// `patchWorkbenchSettings` rename path — no second rename API.

/** Placeholder title for an untitled / blank mint — never a prefab name. */
export const NEW_WORKBENCH_TITLE = "New Workbench";

/** Sidebar-friendly caps — a goal phrase that never truncates in the pill or sidebar. */
export const AUTO_WORKBENCH_TITLE_MAX = 24;
const AUTO_WORKBENCH_TITLE_MAX_WORDS = 4;

const ARTICLES = new Set(["the", "a", "an"]);
const TRAILING_STOPWORDS = new Set([
  ...ARTICLES,
  "for",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "with",
  "my",
  "our",
]);

const LEADING_FILLER =
  /^(?:(?:hey|hi|hello|so|ok|okay)[,\s]+)?(?:(?:can|could|would|will)\s+you\s+|please\s+|pls\s+|i(?:'d| would)? (?:like|want|need) (?:you )?to\s+)+(?:please\s+)?/iu;

// First sentence or clause, filler and articles stripped, first letter
// capitalised, cut to a few whole words — never an ellipsis.
export function titleFromFirstMessage(
  message: string,
  maxLength: number = AUTO_WORKBENCH_TITLE_MAX,
): string | undefined {
  const collapsed = message.trim().replace(/\s+/g, " ");
  const clause = (collapsed.split(/[.!?:;]+(?:\s|$)|\s[-—–]\s/u)[0] ?? "").replace(
    LEADING_FILLER,
    "",
  );
  const words = clause
    .replace(/[\s.,;:!?]+$/u, "")
    .split(" ")
    .filter((word) => word.length > 0 && !ARTICLES.has(word.toLowerCase()));

  const kept: string[] = [];
  for (const word of words.slice(0, AUTO_WORKBENCH_TITLE_MAX_WORDS)) {
    if ([...kept, word].join(" ").length > maxLength) break;
    kept.push(word);
  }
  if (kept.length === 0 && words[0] !== undefined) kept.push(words[0].slice(0, maxLength));
  while (kept.length > 1 && TRAILING_STOPWORDS.has((kept.at(-1) ?? "").toLowerCase())) kept.pop();

  const title = kept.join(" ").replace(/[\s.,;:!?]+$/u, "");
  if (title.length === 0) return undefined;
  return title.charAt(0).toLocaleUpperCase() + title.slice(1);
}

// `undefined` unless the workbench is still the generic placeholder, so
// callers leave prefab (and already-renamed) titles alone.
export function autoNameFromFirstMessage(
  currentTitle: string,
  firstMessage: string,
): string | undefined {
  if (currentTitle !== NEW_WORKBENCH_TITLE) return undefined;
  return titleFromFirstMessage(firstMessage);
}
