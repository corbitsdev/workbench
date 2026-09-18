// A trigger address needs a URL/mail-safe slug. Mirrors
// `apps/web/src/lib/slug/slug.ts` closely enough to derive the same
// address a hand-authored agent gets from the web create-agent panel,
// without this bundle depending on `apps/web`.
const SLUG_MAX_LENGTH = 64;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(name: string): string {
  const ascii = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  const hyphenated = ascii.replace(/[^a-z0-9]+/g, "-");
  return hyphenated.slice(0, SLUG_MAX_LENGTH).replace(/^-+|-+$/g, "");
}

export function isValidSlug(s: string): boolean {
  return s.length > 0 && s.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(s);
}
