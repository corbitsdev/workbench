# @workbench/workflow-blind-ab-comparison

The blind-ab-comparison workflow: run the same prompt across multiple inference
providers, compare the outputs blind, and rank the results — gated on human
review.

Steps:

1. **input** — accept the text or artifact and the shared system prompt.
2. **execute** — run the shared prompt across each selected provider branch.
3. **compare** — blind-rank the provider outputs and summarize the differences.
4. **review** — `awaitSignal('comparison-review')`, a human gate before results
   are persisted.
5. **persist** — save the ranked comparison results as artifacts.

## Shape

This is a native `@intx/workflow` package. It exports:

- `kind` — `'blind-ab-comparison'`
- `workflow` — a `defineWorkflow(...)` definition

Each step agent declares its tools as serializable `capabilities` (e.g.
`artifact_create`), never inline tool factories — the definition is pushed as
JSON.

## Deploy

```bash
bun run workflows:push -- --kind blind-ab-comparison
```

The hub imports no workflow code; it commits this definition to a git-backed
`workflow` repo and launches it on the sidecar. See
[../../docs/DEPLOYING_WORKFLOWS.md](../../docs/DEPLOYING_WORKFLOWS.md) for the
full deploy flow, authorization, and required credentials.
