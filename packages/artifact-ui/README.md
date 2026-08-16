# @corbits/artifact-ui

The artifact library's domain seam: the `ArtifactSummary` type a Library
page renders, plus the sort, filter, kind-coloring, and typed rendering
rules every artifact surface shares — the canvas pane, the Library detail
preview, and an opened chat blob all render through the same
`ArtifactRenderer` so a kind's display has one implementation.
Presentational primitives come from `@corbits/react-ui`
([corbitsdev/react-ui](https://github.com/corbitsdev/react-ui)); this
package holds the workbench-specific composition and domain rules on top
of them.

Rendering is currently read-only (CL-5938); the multiplayer-editing half
is separate follow-up work built on top of this package's substrate.

## Key modules

- `types.ts` — `ArtifactSummary`, the arktype-validated row a Library page
  renders (today mapped from tenant assets; a dedicated artifacts endpoint
  would validate against this same schema)
- `sort-filter.ts` / `kind-filter.ts` — `sortArtifacts`/`filterArtifacts`
  and the Library-path kind-segment rules
- `renderer-kind.ts` — `resolveArtifactRendererKind`, mapping an artifact
  to its `ArtifactRendererKind`
- `artifact-renderer.tsx` — `ArtifactRenderer`, the typed dispatch to one
  renderer per kind
- `artifact-card.tsx` — the Library card, including the kind badge
- `artifact-text-editor.tsx` / `y-text-diff.ts` — the text editor surface
  and its Yjs-backed diff application
- `save-state.ts` — save-state label formatting

## Running tests

```
cd packages/artifact-ui && bun test
```

Suites render with `react-dom/server`'s `renderToStaticMarkup` rather than
a mounted DOM, so no `bunfig.toml` preload is needed here.
