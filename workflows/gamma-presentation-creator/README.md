# @workbench/workflow-gamma-presentation-creator

Turn any artifact, Granola call, or pasted text into a branded Gamma deck,
refining it round by round until a human approves it.

## Shape

This is a native `@intx/workflow` package. It exports:

- `kind` — `'gamma-presentation-creator'`
- `workflow` — a `defineWorkflow(...)` definition

Setup steps list the available artifacts and Granola notes, then an
`intake` `awaitSignal` gate collects the chosen source (artifact / call / pasted
text) plus template, deck title, and audience/tone/goal. The intake UI fetches
the Gamma templates from the hub (`GET /api/v1/gamma-templates`) rather than a
workflow step; that HTTP path also computes per-caller `canManage` and walks
the tenant ancestor chain. (`gamma_list_templates` itself is hub-backed and
CAN run in a workflow step since CL-2597 — the intake UI keeps the HTTP
fetch for those extra projections.) Both readers
(`artifact_read`, `granola_get_note`) run `nonFatal`; the unused one degrades and
`generate` uses whichever source resolved.

The body is a bounded `MAX_ROUNDS` (3) refine loop, each round:

1. **generate-N** — draft the deck content from the source (+ the prior draft and
   feedback on later rounds) via an inline inference step.
2. **render-N** — render the draft into a Gamma deck (`gamma_create_from_template`;
   Gamma cannot edit in place, so each round renders a fresh deck).
3. **preview-N** — `awaitSignal`, a live iframe preview with **Approve** or
   **Refine with notes**.
4. **check-N** — a `gate()`: approval routes to `persist-N` and prunes the
   remaining rounds; refusal feeds the draft + notes into the next round. The
   final round has no gate — its preview leads straight to persistence.

Each round also runs a cheap `describe-N` inference step that writes a one-line
deck description. The approved deck is saved as a `gamma_presentation` artifact
via `artifact_link_gamma_presentation`, whose content is the JSON
`{ url, description, gammaId }` (the rendered deck URL, the description, and the
new deck's Gamma id) — not the LLM's slide text.

Steps declare their tools as serializable `capabilities`, never inline tool
factories — the definition is pushed as JSON.

> Control-flow note: `gate()` runs on the sidecar `@intx/workflow` runtime (the
> live execution path). The in-hub linear executor does not project `gate` and is
> not on the live path; see [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

## Deploy

Push via the admin CLI (`bun run admin` → select a tenant → "Local actions →
Push a workflow"). At the "Workflow kind" prompt, type just the kind value:
`gamma-presentation-creator`.

The hub imports no workflow code; it commits this definition to a git-backed
`workflow` repo and launches it on the sidecar. See
[../../docs/ADMIN_CLI.md](../../docs/ADMIN_CLI.md) for the operator entrypoint,
and [../../docs/DEPLOYING_WORKFLOWS.md](../../docs/DEPLOYING_WORKFLOWS.md) for the
full deploy flow, authorization, and required credentials.
