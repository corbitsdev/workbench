// The slug is never derived here: guessing one from a display name
// produces a URL that 404s the moment the two disagree. An entity with no
// real slug falls back to its own opaque id instead.

import { isValidSlug } from "@/lib/slug";

export type DetailAddressable = {
  /** The entity's own minted slug, as the server returned it. */
  readonly slug: string;
  /** The opaque id its roster deep link accepts. */
  readonly id: string;
};

export function detailPath(rosterPath: string, entity: DetailAddressable): string {
  if (isValidSlug(entity.slug)) return `${rosterPath}/${entity.slug}`;
  return `${rosterPath}/${encodeURIComponent(entity.id)}`;
}
