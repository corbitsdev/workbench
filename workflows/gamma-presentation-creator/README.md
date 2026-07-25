# @workbench/workflow-gamma-presentation-creator

Turn any artifact, Granola call, or pasted text into a branded Gamma deck in a
single generation pass.

## Shape

This is a native `@intx/workflow` package. It exports:

- `kind` — `'gamma-presentation-creator'`
- `workflow` — a `defineWorkflow(...)` definition

Setup steps list the available artifacts and Granola notes, then an
`intake` `awaitSignal` gate collects the chosen source (artifact / call / pasted
text) plus template, deck title, and audience/tone/goal. Audience, tone, and goal
are optional preset dropdowns (with a free-text escape) sourced from one shared
list in `intake-defaults.ts`. The intake UI fetches the Gamma templates from the
hub (`GET /api/v1/gamma-templates`) rather than a workflow step; that HTTP path
also computes per-caller `canManage` and walks the tenant ancestor chain.
(`gamma_list_templates` itself is hub-backed and CAN run in a workflow step since
CL-2597 — the intake UI keeps the HTTP fetch for those extra projections.) The
selected template's optional `systemPrompt` is relayed on the intake payload as
`templateSystemPrompt` so the generate step can apply per-template authoring
guidance. Both readers (`artifact_read`, `granola_get_note`) carry an `optional`
argMap field and `nonFatal`; the reader whose source was not chosen skips cleanly
and `generate` uses whichever source resolved.

`intake` is the workflow's only human gate. After it the run proceeds straight
through, with no per-round preview or approval:

1. **generate** — draft the deck content from the source via an inline inference
   step, applying the base authoring rules plus any `templateSystemPrompt`.
2. **render** — render the draft into a Gamma deck (`gamma_create_from_template`).
3. **describe** — a cheap inline inference step that writes a one-line deck
   description.
4. **persist** — save the deck as a `gamma_presentation` artifact via
   `artifact_link_gamma_presentation`, whose content is the JSON
   `{ url, description, gammaId }` (the rendered deck URL, the description, and the
   new deck's Gamma id) — not the LLM's slide text.

`render` also surfaces a temporary Gamma export URL (`exportUrl`), which the
persist step passes as `pdfUrl`. The handler downloads the deck PDF and stores
it durably alongside the deck link. The artifact view renders that PDF inline
(falling back to the Gamma embed when there is none). The PDF is supplementary —
a failed or oversize export still saves the deck link. See
`packages/tools-gamma/README.md` for the export/expiry details.

Review happens on the saved artifact, not in the run: a deck you want to change
is a fresh run rather than an in-run refine.

Steps declare their tools as serializable `capabilities`, never inline tool
factories — the definition is pushed as JSON.

### Native `action` steps (CL-4454)

Every deterministic tool step except the two source readers now runs as a
native `@intx/workflow` `action` rather than the workbench-local
`deterministicToolStep`/`workbench.argMap` path. `fetch-artifact` and
`fetch-note` stay on `deterministicToolStep`: they are `nonFatal` (an
unresolved source degrades to "not available" rather than failing the run),
and `ActionPrimitive` has no non-fatal / error-swallow equivalent.

Native selectors (`from`/`project`/`merge`/`literal`) cannot rename a field,
so wherever an upstream field name didn't already match the downstream tool's
argument name, this package ships its own small shaping tools rather than
renaming a shared, multi-caller tool or aliasing a workflow-owned convention:

- `gamma_presentation_creator_prepare_render` renames the draft agent's
  `reply` to `gamma_create_from_template`'s `prompt` argument.
- `gamma_presentation_creator_prepare_persist` pairs the intake `deckTitle`,
  the describe agent's `reply`, and the rendered deck's `url`/`gammaId`/
  `exportUrl` into `artifact_link_gamma_presentation`'s argument names
  (`title`/`description`/`pdfUrl`, `url`/`gammaId` already match verbatim).

Both live in `src/tools.ts`, registered via the package's own
`interchange.tools`/`interchange.manifest` block (`src/interchange-tools.ts`,
`src/tool-manifest.ts`) — mirroring `workflows/exa-topic-watch`'s pattern —
rather than in a shared `packages/tools-*` package, since they are private to
this workflow.

## Deploy

Push via the admin CLI (`bun run admin` → select a tenant → "Local actions →
Push a workflow"). At the "Workflow kind" prompt, type just the kind value:
`gamma-presentation-creator`.

The hub imports no workflow code; it commits this definition to a git-backed
`workflow` repo and launches it on the sidecar. See
[../../docs/ADMIN_CLI.md](../../docs/ADMIN_CLI.md) for the operator entrypoint,
and [../../docs/DEPLOYING_WORKFLOWS.md](../../docs/DEPLOYING_WORKFLOWS.md) for the
full deploy flow, authorization, and required credentials.
