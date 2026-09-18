// Rendering — the overlay, keyboard contract, grouped/loading/empty
// states — stays a react-ui concern; this package owns only the data.
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

export { isBareScopeQuery, parsePaletteQuery, PALETTE_SCOPES } from "./scope";
export type { ParsedPaletteQuery, PaletteScope, PaletteScopeKind } from "./scope";

export { buildCommandPaletteGroups } from "./command-groups";
export type {
  BuildCommandPaletteGroupsInput,
  PaletteResultGroup,
  PaletteResultItem,
  PaletteSource,
} from "./command-groups";

export { detailPath } from "./detail-paths";
export type { DetailAddressable } from "./detail-paths";

export { addRecentEntry, createRecentsStore, removeRecentEntry } from "./recents";
export type { RecentEntry, RecentsStorage, RecentsStore } from "./recents";
