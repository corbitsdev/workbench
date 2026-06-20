# @workbench/workflow-seo-enrichment

The seo-enrichment workflow: turn an uploaded product workbook into a
downloadable CSV of SEO titles, descriptions, and summaries, gated on a human
selecting one option per field per row.

Steps:

1. **intake** — parse the uploaded product workbook into resource rows.
2. **enrich** — generate five SEO title, description, and summary variants per
   row.
3. **review** — `awaitSignal('row-selection')`, a human gate where the reviewer
   picks one option per field for each row.
4. **export** — assemble the chosen options into a downloadable CSV.

## Shape

This is a native `@intx/workflow` package. It exports:

- `kind` — `'seo-enrichment'`
- `workflow` — a `defineWorkflow(...)` definition

Each step agent declares its tools as serializable `capabilities` (e.g.
`upload_read`, `artifact_create`), never inline tool factories — the definition
is pushed as JSON.

## Deploy

```bash
bun run workflows:push -- --kind seo-enrichment
```

The hub imports no workflow code; it commits this definition to a git-backed
`workflow` repo and launches it on the sidecar. See
[../../docs/DEPLOYING_WORKFLOWS.md](../../docs/DEPLOYING_WORKFLOWS.md) for the
full deploy flow, authorization, and required credentials.
