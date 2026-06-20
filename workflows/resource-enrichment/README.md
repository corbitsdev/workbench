# @workbench/workflow-resource-enrichment

The resource-enrichment workflow: upload a resource file, generate option
variants per row, pick one per field, and download a CSV — gated on human
review.

Steps:

1. **intake** — parse the uploaded resource file into structured rows.
2. **enrich** — generate option variants for each row's fields.
3. **review** — `awaitSignal('selection-approval')`, a human gate where the
   reviewer picks one option per field for each row.
4. **export** — assemble the chosen options into a downloadable CSV.

## Shape

This is a native `@intx/workflow` package. It exports:

- `kind` — `'resource-enrichment'`
- `workflow` — a `defineWorkflow(...)` definition

Each step agent declares its tools as serializable `capabilities` (e.g.
`artifact_create`, `write_artifact`), never inline tool factories — the
definition is pushed as JSON.

## Deploy

```bash
bun run workflows:push -- --kind resource-enrichment
```

The hub imports no workflow code; it commits this definition to a git-backed
`workflow` repo and launches it on the sidecar. See
[../../docs/DEPLOYING_WORKFLOWS.md](../../docs/DEPLOYING_WORKFLOWS.md) for the
full deploy flow, authorization, and required credentials.
