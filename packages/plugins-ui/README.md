# @corbits/plugins-ui

The Plugins gallery: connector and skill cards, search, an installed strip,
and a one-flow connect panel — presentational components composed from the
connections registry and skill registry the Settings surfaces already
read. Every list arrives already loaded; the composing page (`apps/web`)
owns fetching data and passes it down.

## How it composes

- Reads `ResolvedPlugin` from `@corbits/connections/plugins` — the
  tenant-inheritance-aware resolver — rather than re-deriving connection
  status itself.
- `PluginConnectPanel` reuses the exact mutations `@corbits/settings-ui`'s
  own Connections section calls (`completeConnectorCredential`,
  `deleteCredential`, `oauthStartHref`),
  and mounts `@corbits/settings-ui`'s `GranolaWebhookCard` wholesale for
  Granola's key-plus-webhook connect rather than forking its dialog.
- Built on `@corbits/react-ui` primitives (`Card`, `Badge`, `Dialog`,
  `Tabs`, `EmptyState`, `LibrarySearchInput`) — see
  [corbitsdev/react-ui](https://github.com/corbitsdev/react-ui) for the
  underlying design system; this package only adds workbench-specific
  composition.

## Key modules

- `plugins-gallery.tsx` — Plugins | Skills tabs over one search box, an
  installed strip, and a Featured-then-category card grid.
- `plugin-card.tsx` — one plugin's icon, name, outcome sentence, and a
  single action that reads honestly off the connector's real status.
- `skill-card.tsx` — a skill given the same card treatment, with a
  "shared"/"private" scope badge.
- `installed-strip.tsx` — the at-a-glance row of already-connected
  plugins above the search/category grid.
- `plugin-connect-panel.tsx` — the right-docked connect flow for every
  connector kind (OAuth, api-key, Granola's key-plus-webhook).
- `plugin-meta.ts` — presentation-only sidecar lookups (icon, category,
  outcome copy) keyed by connector id; the connector set itself
  (`templates/connectors.ts`'s `CONNECTOR_REGISTRY`) stays UI-agnostic.

## Running tests

```
cd packages/plugins-ui && bun test
```

Tests run in a DOM environment (`@happy-dom/global-registrator`, preloaded
via `bunfig.toml`); no live database or external credentials required.
