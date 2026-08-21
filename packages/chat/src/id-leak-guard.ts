// The systemic guard CL-6471 calls for: a person never sees an internal
// identifier — not as a participant's name, not in a join/system line,
// not in a greeting, not in a chat title. This has recurred repeatedly
// (a raw definitionId/runId in insights, a `writing_systems` id in a
// Myra reply, and CL-6471's own "Run 737a058d…" / "I'm run_737a…") each
// time as a one-off display-time patch; this module is the one place
// every id-generating prefix is named, so a new leak is a missed test
// run rather than a missed grep.
//
// Prefix words mirror `@intx/hub-common`'s `generateId` (vendored;
// upstream source: `packages/hub-common/src/ids.ts`'s `PREFIXES`) for
// the six kinds CL-6471 names explicitly — a workflow run, a workflow
// definition, a tenant, a principal, an asset, and a git token — each
// normally followed by `_` and 32 lowercase hex characters (`run_737a…`).
//
// Matched with either `_`, a space, or `-` as the separator, not just
// `_`: `humanizeSlug`'s Title Case reading of a leaked id (CL-6471's own
// "Run 737a058d48006e2bde12559576f422e0") replaces the underscore with a
// space, so the raw and the humanized-leak forms both need to trip this.
const ID_PREFIX_WORDS = ["run", "wfd", "tnt", "prn", "ast", "gtk"] as const;

export const ID_LEAK_PATTERN = new RegExp(
  `\\b(?:${ID_PREFIX_WORDS.join("|")})[_\\s-][0-9a-f]{16,}\\b`,
  "i",
);

/**
 * Throws when `value` carries an internal identifier — a raw id, or a
 * humanized reading of one (`"Run 737a058d…"`, produced by title-casing
 * `run_737a058d…`'s underscore split). The humanized case is why this
 * checks the ORIGINAL prefixes case-insensitively rather than requiring
 * the literal lowercase prefix: `humanizeSlug` capitalizes the first
 * letter of the leading word, so a leaked run id renders as "Run …", not
 * "run …", by the time it would reach a person.
 */
export function assertNoLeakedInternalId(value: string, context: string): void {
  if (ID_LEAK_PATTERN.test(value)) {
    throw new Error(
      `${context} carries an internal identifier ("${value}"); a person ` +
        "must never see one — resolve the real name at the source instead " +
        "of rendering the id (CL-6471)",
    );
  }
}
