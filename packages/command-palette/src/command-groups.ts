import { matchesQuery } from "./static-commands";
import { parsePaletteQuery, type PaletteScopeKind } from "./scope";

/** One result row a consumer already resolved from its own data — this
 * module never looks past `title`/`subtitle` for matching or display. */
export type PaletteResultItem = {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  /** Text to match the query against, when it should differ from
   * `title subtitle` (e.g. to also match a channel section or an id alias).
   * Defaults to `title` + `subtitle`. */
  readonly searchText?: string;
};

export type PaletteResultGroup = {
  readonly id: string;
  readonly heading: string;
  readonly items: readonly PaletteResultItem[];
};

/** One group of results, in the order it should appear among its siblings.
 * `kind` gates it to a prefix scope (`#`, `@`, `>`, `/`): visible when no
 * scope is active, or when the active scope matches. Omitting `kind` makes
 * it an unscoped-only group — the mock's Routines, Skills, Library and
 * Threads groups — visible only in the default (no scope) view. */
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
  /** Every other group, already in the exact order they should render in —
   * scoped and unscoped groups may be interleaved, matching the mock's
   * Commands/Channels/Pages/Settings/Artifacts/Routines/Threads/People
   * order (People last). */
  readonly sources: readonly PaletteSource[];
};

function filterItems(
  items: readonly PaletteResultItem[],
  query: string,
): readonly PaletteResultItem[] {
  if (query === "") return items;
  return items.filter((item) =>
    matchesQuery(
      item.searchText ?? `${item.title} ${item.subtitle ?? ""}`,
      query,
    ),
  );
}

/**
 * Builds the palette's grouped, ordered result list from already-fetched
 * data: parses the `#`/`@`/`>`/`/` scope prefix, applies it to each scoped
 * source, folds in unscoped sources only in the default view, and shows
 * `recents` only on the empty, unscoped view — the same rules
 * `buildCmdkEntries` in the shell mock encodes. Pure: no fetch, no state.
 */
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
