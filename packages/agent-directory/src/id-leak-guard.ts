// A person must never see an internal identifier. This has recurred
// repeatedly as one-off display-time patches; this module is the one place
// every id-generating prefix is named, so a new leak is a missed test run
// rather than a missed grep. Matched with `_`, space, or `-` as the
// separator, since `humanizeSlug`'s Title Case reading turns an underscore
// into a space.
const ID_PREFIX_WORDS = ["run", "wfd", "tnt", "prn", "ast", "gtk"] as const;

export const ID_LEAK_PATTERN = new RegExp(
  `\\b(?:${ID_PREFIX_WORDS.join("|")})[_\\s-][0-9a-f]{16,}\\b`,
  "i",
);

/** Throws when `value` carries an internal identifier — a raw id, or a
 * humanized reading of one, matched case-insensitively since
 * `humanizeSlug` capitalizes the leading word. */
export function assertNoLeakedInternalId(value: string, context: string): void {
  if (ID_LEAK_PATTERN.test(value)) {
    throw new Error(
      `${context} carries an internal identifier ("${value}"); a person ` +
        "must never see one — resolve the real name at the source instead " +
        "of rendering the id",
    );
  }
}
