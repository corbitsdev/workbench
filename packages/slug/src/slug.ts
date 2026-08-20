/** Slugs are the URL-facing name of an entity: lowercase ASCII words joined
 * by single hyphens, capped so a slug always fits a path segment, a DB
 * column, and a page title without truncation surprises. */
export const SLUG_MAX_LENGTH = 64;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Derive a slug from a display name: accents folded to ASCII, everything
 * that is not a letter or digit collapsed into a single hyphen, and the
 * result capped at `SLUG_MAX_LENGTH` without leaving a trailing hyphen. A
 * name with nothing sluggable in it (punctuation, emoji, a non-Latin
 * script) yields the empty string — the caller decides what to do with a
 * name that cannot name a URL.
 */
export function slugify(name: string): string {
  const ascii = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const hyphenated = ascii.replace(/[^a-z0-9]+/g, "-");
  return hyphenated.slice(0, SLUG_MAX_LENGTH).replace(/^-+|-+$/g, "");
}

declare const validated: unique symbol;

/** A string that has been through `isValidSlug` — the brand makes the
 * "validated at the boundary" fact visible in types, so a raw URL segment
 * can never stand in for a slug by accident. */
export type Slug = string & { readonly [validated]: true };

/** True for a string that is already a slug — the shape `slugify` produces,
 * and the only shape a slug-addressed route accepts from a URL. */
export function isValidSlug(s: string): s is Slug {
  return s.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(s);
}
