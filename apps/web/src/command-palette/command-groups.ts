import { matchesQuery } from "./static-commands";
import { parsePaletteQuery, type PaletteScopeKind } from "./scope";

/** One result row a consumer already resolved from its own data — this
 * module never looks past `title`/`subtitle` for matching or display. */
export type PaletteResultItem = {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  /** Text to match the query against, when it should differ from
   * `title subtitle` (e.g. to also match a workbench section or an id alias).
   * Defaults to `title` + `subtitle`. */
  readonly searchText?: string;
};

export type PaletteResultGroup = {
  readonly id: string;
  readonly heading: string;
  readonly items: readonly PaletteResultItem[];
};

// Omitting `kind` makes it an unscoped-only group, visible only in the
// default (no scope) view.
export type PaletteSource = {
  readonly id: string;
  readonly heading: string;
  readonly items: readonly PaletteResultItem[];
  readonly kind?: PaletteScopeKind;
};

export type BuildCommandPaletteGroupsInput = {
  /** The raw palette input, scope prefix included. */
  readonly query: string;
  /** Already-ordered, already-capped Recents rows; shown only when the
   * query is empty and no scope prefix is active. */
  readonly recents: readonly PaletteResultItem[];
  // Already in the exact order they should render in; scoped and
  // unscoped groups may be interleaved.
  readonly sources: readonly PaletteSource[];
};

function filterItems(
  items: readonly PaletteResultItem[],
  query: string,
): readonly PaletteResultItem[] {
  if (query === "") return items;
  return items.filter((item) =>
    matchesQuery(item.searchText ?? `${item.title} ${item.subtitle ?? ""}`, query),
  );
}

// Pure: no fetch, no state. `recents` shows only on the empty, unscoped
// view.
export function buildCommandPaletteGroups(
  input: BuildCommandPaletteGroupsInput,
): readonly PaletteResultGroup[] {
  const { scope, query } = parsePaletteQuery(input.query);
  const groups: PaletteResultGroup[] = [];

  if (scope === null && query === "" && input.recents.length > 0) {
    groups.push({ id: "recents", heading: "Recent", items: input.recents });
  }

  for (const source of input.sources) {
    if (source.kind === undefined) {
      if (scope !== null) continue;
    } else if (scope !== null && scope.kind !== source.kind) {
      continue;
    }
    const items = filterItems(source.items, query);
    if (items.length > 0) {
      groups.push({ id: source.id, heading: source.heading, items });
    }
  }

  return groups;
}
