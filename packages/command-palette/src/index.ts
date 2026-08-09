// `@corbits/command-palette`: what the global command palette can show.
// `buildStaticCommands` turns the app shell's own route table into commands.
// `searchEntities` is the pure match/paginate core over already-fetched
// entity lists (channels, routines, agents — any source the consumer wires);
// `useEntitySearch` is the one piece of React this package owns — debouncing
// a typed query and fetching those lists, because that timing and caching is
// inseparable from the pagination it resets. Rendering — the overlay, the
// keyboard contract, the grouped/loading/empty/load-more states — stays a
// react-ui concern.
export { buildStaticCommands, matchesQuery } from "./static-commands";
export type { StaticCommand, StaticRoute } from "./static-commands";

export { searchEntities } from "./entity-search";
export type {
  EntitySearchPage,
  EntitySearchResult,
  EntitySource,
  SearchableEntity,
  SearchEntitiesInput,
} from "./entity-search";

export { useEntitySearch } from "./use-entity-search";
export type {
  EntitySourceFetcher,
  UseEntitySearchOptions,
  UseEntitySearchResult,
} from "./use-entity-search";
