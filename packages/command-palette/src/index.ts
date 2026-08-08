// `@corbits/command-palette`: what the global command palette can show,
// kept UI-free. `buildStaticCommands` turns the app shell's own route table
// into commands; `searchEntities` matches already-fetched channels and
// workflow runs against a query. Rendering — the overlay, the keyboard
// contract, the grouped/loading/empty/load-more states — is a react-ui
// concern, never built here.
export { buildStaticCommands, matchesQuery } from "./static-commands";
export type { StaticCommand, StaticRoute } from "./static-commands";

export { searchEntities } from "./entity-search";
export type {
  EntitySearchPage,
  EntitySearchResult,
  SearchableEntity,
  SearchEntitiesInput,
} from "./entity-search";
