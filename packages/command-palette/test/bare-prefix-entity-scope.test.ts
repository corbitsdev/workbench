import { describe, expect, test } from "bun:test";

import { isBareScopeQuery, parsePaletteQuery } from "../src/scope";
import { searchEntities } from "../src/entity-search";
import { buildCommandPaletteGroups } from "../src/command-groups";

describe("bare `#` scope against entity-search-backed sources", () => {
  test("a bare # prefix strips to an empty query, and searchEntities returns nothing for an empty query", () => {
    const { query } = parsePaletteQuery("#");
    expect(query).toBe("");

    const page = searchEntities({
      query,
      sources: [
        {
          category: "channels",
          entities: [
            { id: "eng", name: "Engineering" },
            { id: "design", name: "Design" },
          ],
        },
      ],
      pageSize: 20,
      offset: 0,
    });

    // This is the documented searchEntities contract: empty query -> no
    // results (the default, unscoped view should not dump every entity the
    // instant the palette opens). `isBareScopeQuery` is how a
    // debounced-search-backed consumer (command-palette-provider.tsx) tells
    // this case apart from a genuinely empty, unscoped view, so it can fetch
    // the scope's raw list directly instead of routing "" through
    // searchEntities.
    expect(page.results).toEqual([]);
    expect(isBareScopeQuery("#")).toBe(true);
  });

  test("buildCommandPaletteGroups still shows every item once the caller supplies the unfiltered list for a bare scope", () => {
    const emptyItems = buildCommandPaletteGroups({
      query: "#",
      recents: [],
      sources: [
        {
          id: "channels",
          heading: "Channels",
          kind: "channels",
          // What entity-search alone would hand a bare `#`: nothing, since
          // it never even fetches for an empty query.
          items: [],
        },
      ],
    });
    expect(emptyItems).toEqual([]);

    const unfilteredItems = buildCommandPaletteGroups({
      query: "#",
      recents: [],
      sources: [
        {
          id: "channels",
          heading: "Channels",
          kind: "channels",
          // What the provider now supplies for a bare scope: the raw,
          // unfiltered list fetched directly (see isBareScopeQuery above).
          items: [
            { id: "entity:channels:eng", title: "Engineering" },
            { id: "entity:channels:design", title: "Design" },
          ],
        },
      ],
    });
    expect(unfilteredItems).toEqual([
      {
        id: "channels",
        heading: "Channels",
        items: [
          { id: "entity:channels:eng", title: "Engineering" },
          { id: "entity:channels:design", title: "Design" },
        ],
      },
    ]);
  });
});
