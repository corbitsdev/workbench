import { matchesQuery } from "./static-commands";

/** One entity result. Only `title` is ever shown — never the id it carries
 * for selection, so a consumer wiring this into a UI can never regress the
 * "no raw identifier on screen" floor by accident. */
export type EntitySearchResult = {
  readonly id: string;
  readonly title: string;
  /** Which source the result came from — a free-form label the consumer
   * defines (e.g. `"workbenches"`, `"routines"`, `"agents"`). The package
   * never interprets it; it only carries it through so the app shell can
   * group results and map a selection back to the right route. */
  readonly category: string;
};

export type EntitySearchPage = {
  readonly results: readonly EntitySearchResult[];
  readonly hasMore: boolean;
};

/** The bare shape entity search needs from an already-fetched, already-typed
 * list — workbenches, routines, agents, etc. all already come off
 * arktype-validated API responses before they reach here, so this module
 * trusts the shape it is handed. */
export type SearchableEntity = {
  readonly id: string;
  readonly name: string;
};

/** A named bundle of entities the search core matches against. The
 * `category` label flows through to every result so the consumer can group
 * and route them without re-deriving provenance. */
export type EntitySource = {
  readonly category: string;
  readonly entities: readonly SearchableEntity[];
};

export type SearchEntitiesInput = {
  readonly query: string;
  readonly sources: readonly EntitySource[];
  readonly pageSize: number;
  readonly offset: number;
};

/**
 * Client-side search over entities the app has already fetched for its own
 * pages — workbenches, routines, agents, whatever the consumer hands in. There
 * is no cross-tenant search endpoint yet, so every source is an
 * already-fetched list matched here.
 *
 * An empty query returns nothing rather than everything: the palette's own
 * "type to search" state covers that case, and dumping every entity into
 * the list the instant the palette opens would make the static commands
 * compete with noise for the first keystroke.
 *
 * Results preserve source order: if the consumer passes workbenches before
 * routines, workbench matches appear first within a page.
 */
export function searchEntities({
  query,
  sources,
  pageSize,
  offset,
}: SearchEntitiesInput): EntitySearchPage {
  if (query.trim().length === 0) return { results: [], hasMore: false };

  const matched: EntitySearchResult[] = [];
  for (const source of sources) {
    for (const entity of source.entities) {
      if (matchesQuery(entity.name, query)) {
        matched.push({
          id: entity.id,
          title: entity.name,
          category: source.category,
        });
      }
    }
  }

  const page = matched.slice(offset, offset + pageSize);
  return { results: page, hasMore: offset + pageSize < matched.length };
}
