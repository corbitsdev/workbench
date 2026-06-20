# @workbench/workflow-seo-enrichment-from-image

The seo-enrichment-from-image workflow: given a product image URL, generate SEO
titles, descriptions, and summaries for a target page, gated on a human
selecting one option per field per row.

Steps:

1. **intake** — parse the image and target page into resource rows.
2. **enrich** — generate five SEO title, description, and summary variants per
   row.
3. **review** — `awaitSignal('row-selection')`, a human gate where the reviewer
   picks one option per field for each row.
4. **export** — assemble the chosen options into a downloadable CSV.

## Shape

This is a native `@intx/workflow` package. It exports:

- `kind` — `'seo-enrichment-from-image'`
- `label` — `'SEO Enrichment from Image'`
- `workflow` — a `defineWorkflow(...)` definition

## Deploy

```bash
bun run workflows:push -- --kind seo-enrichment-from-image
```

The hub imports no workflow code; it commits this definition to a git-backed
`workflow` repo and launches it on the sidecar. See
[../../docs/DEPLOYING_WORKFLOWS.md](../../docs/DEPLOYING_WORKFLOWS.md) for the
full deploy flow, authorization, and required credentials.
