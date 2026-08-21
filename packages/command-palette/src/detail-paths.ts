// Where a palette result lands. DESIGN.md's Detail Pages section addresses
// every browsable entity by slug (`/agents/<slug>`), so a result row has to
// resolve to that route when the entity carries a real slug.
//
// The slug is never derived here. A slug is minted once, at creation, and is
// immutable; guessing one from a display name produces a URL that 404s the
// moment the two disagree (an accent folded differently, a rename, a name
// that was never sluggable). An entity whose slug is not a slug — an import
// race, an external id, a handle minted before the rule tightened — falls
// back to its own opaque id, which every roster still resolves as a deep
// link into that row.

import { isValidSlug } from "@corbits/slug";

export type DetailAddressable = {
  /** The entity's own minted slug, as the server returned it. */
  readonly slug: string;
  /** The opaque id its roster deep link accepts. */
  readonly id: string;
};

export function detailPath(
  rosterPath: string,
  entity: DetailAddressable,
): string {
  if (isValidSlug(entity.slug)) return `${rosterPath}/${entity.slug}`;
  return `${rosterPath}/${encodeURIComponent(entity.id)}`;
}
