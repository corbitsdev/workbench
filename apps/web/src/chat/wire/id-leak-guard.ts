// Mirrored from packages/chat/src (see docs/chat-wire-contract.md, which
// also covers this file's rationale).

// Matches `_`, space, or `-` as separator so both the raw id and
// `humanizeSlug`'s Title-Cased reading of one ("Run 737a058d…") trip it.
const ID_PREFIX_WORDS = ["run", "wfd", "tnt", "prn", "ast", "gtk"] as const;

export const ID_LEAK_PATTERN = new RegExp(
  `\\b(?:${ID_PREFIX_WORDS.join("|")})[_\\s-][0-9a-f]{16,}\\b`,
  "i",
);

// Case-insensitive because `humanizeSlug` capitalizes the leading word
// ("Run …") before this would ever see it.
export function assertNoLeakedInternalId(value: string, context: string): void {
  if (ID_LEAK_PATTERN.test(value)) {
    throw new Error(
      `${context} carries an internal identifier ("${value}"); a person ` +
        "must never see one — resolve the real name at the source instead " +
        "of rendering the id",
    );
  }
}
