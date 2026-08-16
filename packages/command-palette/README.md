# @corbits/command-palette

The global command-palette registry: static navigation commands built from
the host app's own route table, plus debounced, paginated entity search
over whatever entity sources (channels, routines, agents) the host wires
in. Rendering — the overlay, keyboard contract, grouped/loading/empty/
load-more states — is a `@corbits/react-ui`
([corbitsdev/react-ui](https://github.com/corbitsdev/react-ui)) concern;
this package owns only the data and matching logic behind it.

## Key modules

- `static-commands.ts` — `buildStaticCommands` turns a route table into
  palette commands; `matchesQuery` is the match rule
- `entity-search.ts` — `searchEntities`, the pure match/paginate core over
  already-fetched entity lists
- `use-entity-search.ts` — the one React hook this package owns: debounces
  a typed query and fetches entity pages, since that timing is inseparable
  from the pagination it resets
- `scope.ts` — `parsePaletteQuery`/`PALETTE_SCOPES`, the prefix-scope rules
  (e.g. `#` for channels)
- `command-groups.ts` — `buildCommandPaletteGroups`, the grouping rules the
  palette UI renders from
- `recents.ts` — the small Recents store

## Running tests

```
cd packages/command-palette && bun test
```

Some suites mount into a real DOM (see `test/dom-setup.ts`); running from
the package directory picks up `bunfig.toml`'s preload.
