# @workbench/workflow-presentation-generation

The presentation-generation workflow: turn call transcripts and notes into
branded Gamma presentations, gated on human review.

Steps:

1. **template** — pick a Gamma template and set audience, tone, and goal.
2. **source** — choose where content comes from: a Granola call, an existing
   artifact, or pasted text.
3. **generate** — draft the deck content from the resolved source.
4. **review** — `awaitSignal('review-approval')`, a human gate before the deck
   is rendered.
5. **render** — render the approved content into a branded Gamma presentation.

## Shape

This is a native `@intx/workflow` package. It exports:

- `kind` — `'presentation-generation'`
- `workflow` — a `defineWorkflow(...)` definition

Each step agent declares its tools as serializable `capabilities` (e.g.
`granola_get_note`, `gamma_generate`), never inline tool factories — the
definition is pushed as JSON.

## Deploy

Push via the admin CLI (`bun run admin` → select a tenant → "Local actions →
Push a workflow"). At the "Workflow kind" prompt, type just the kind value:
`gamma-presentation-creator`.

The hub imports no workflow code; it commits this definition to a git-backed
`workflow` repo and launches it on the sidecar. See
[../../docs/ADMIN_CLI.md](../../docs/ADMIN_CLI.md) for the operator entrypoint,
and [../../docs/DEPLOYING_WORKFLOWS.md](../../docs/DEPLOYING_WORKFLOWS.md) for the
full deploy flow, authorization, and required credentials.
