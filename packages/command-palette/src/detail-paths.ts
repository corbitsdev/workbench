// Where a palette result lands. DESIGN.md's Detail Pages section addresses
// every browsable entity by slug (`/agents/<slug>`), so a result row has to
// resolve a name to that route rather than to an id-shaped path its roster
// would swallow. A name that cannot name a URL resolves to the roster
// instead — never a fabricated slug that could collide with a real one.

import { isValidSlug, slugify } from "@corbits/slug";

export function detailPathForName(rosterPath: string, name: string): string {
  const slug = slugify(name);
  return isValidSlug(slug) ? `${rosterPath}/${slug}` : rosterPath;
}
