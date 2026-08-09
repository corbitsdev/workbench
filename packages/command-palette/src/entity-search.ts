import { matchesQuery } from "./static-commands";

/** One entity result. Only `title` is ever shown — never the id it carries
 * for selection, so a consumer wiring this into a UI can never regress the
 * "no raw identifier on screen" floor by accident. */
export type EntitySearchResult = {
  readonly id: string;
  readonly title: string;
  readonly category: "channels" | "routines";
};

export type EntitySearchPage = {
  readonly results: readonly EntitySearchResult[];
  readonly hasMore: boolean;
};

/** The bare shape entity search needs from an already-fetched, already-typed
 * list — channels and workflow runs both already come off arktype-validated
 * API responses (`@corbits/chat-ui`'s `Channel`, workbench's `WorkflowRun`)
 * before they reach here, so this module trusts the shape it is handed. */
export type SearchableEntity = {
  readonly id: string;
  readonly name: string;
};

export type SearchEntitiesInput = {
  readonly query: string;
  readonly channels: readonly SearchableEntity[];
  readonly runs: readonly SearchableEntity[];
  readonly pageSize: number;
  readonly offset: number;
};

/**
 * Client-side search over entities the app has already fetched for its own
 * pages (`listChannels`, the workflow-runs list) — there is no cross-tenant
 * search endpoint yet for artifacts or agent definitions, so those two
 * categories are not included here (see docs/command-palette.md).
 *
 * An empty query returns nothing rather than everything: the palette's own
 * "type to search" state covers that case, and dumping every channel and
 * every run into the list the instant the palette opens would make the
 * static commands compete with noise for the first keystroke.
 */
export function searchEntities({
  query,
  channels,
  runs,
  pageSize,
  offset,
}: SearchEntitiesInput): EntitySearchPage {
  if (query.trim().length === 0) return { results: [], hasMore: false };

  const matched: EntitySearchResult[] = [
    ...channels
      .filter((channel) => matchesQuery(channel.name, query))
      .map((channel) => ({
        id: channel.id,
        title: channel.name,
        category: "channels" as const,
      })),
    ...runs
      .filter((run) => matchesQuery(run.name, query))
      .map((run) => ({
        id: run.id,
        title: run.name,
        category: "routines" as const,
      })),
  ];

  const page = matched.slice(offset, offset + pageSize);
  return { results: page, hasMore: offset + pageSize < matched.length };
}
