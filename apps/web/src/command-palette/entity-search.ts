import { matchesQuery } from "./static-commands";

// Only `title` is ever shown, never the id, so a consumer can't regress
// the "no raw identifier on screen" floor by accident.
export type EntitySearchResult = {
  readonly id: string;
  readonly title: string;
  // The package never interprets this — only carries it through so the
  // app shell can group results and map a selection to a route.
  readonly category: string;
};

export type EntitySearchPage = {
  readonly results: readonly EntitySearchResult[];
  readonly hasMore: boolean;
};

// Already-typed data from arktype-validated API responses — this module
// trusts the shape it's handed.
export type SearchableEntity = {
  readonly id: string;
  readonly name: string;
};

// `category` flows through to every result so the consumer can group and
// route them without re-deriving provenance.
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

// There's no cross-tenant search endpoint yet, so every source is an
// already-fetched list. An empty query returns nothing rather than
// dumping every entity in, competing with static commands on open.
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
