# Documentation index

This `docs/` tree is the top-level product, architecture, and cross-package
documentation surface. Package-specific contracts and implementation details
live next to each package (in `packages/<name>/README.md`) and are linked from
here rather than duplicated — duplicated detail drifts.

## Read first

| If you are…                                            | Read                                                                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| New to the product                                     | [`PRODUCT.md`](PRODUCT.md) — the product model and user-facing features                                                     |
| Designing a change                                     | [`ARCHITECTURE.md`](ARCHITECTURE.md) — system design, the generic workflow-run + artifact model, Interchange boundary       |
| Understanding how a workflow runs                      | [`WORKFLOWS.md`](WORKFLOWS.md) — the execution model, divergences from Interchange + why, the vendored surface, convergence |
| Implementing in the hub/sidecar                        | [`IMPLEMENTATION.md`](IMPLEMENTATION.md) — technical details and conventions                                                |
| Calling or extending the HTTP API                      | [`API.md`](API.md)                                                                                                          |
| Insights / usage analytics                             | [`ANALYTICS.md`](ANALYTICS.md)                                                                                              |
| Adding an agent or tool                                | [`CREATING_AGENTS_AND_TOOLS.md`](CREATING_AGENTS_AND_TOOLS.md)                                                              |
| Working on the call-to-artifact pipeline               | [`SOURCE_TO_ARTIFACT.md`](SOURCE_TO_ARTIFACT.md)                                                                            |
| Operating the hub (seeding, tenancy, tools, workflows) | [`ADMIN_CLI.md`](ADMIN_CLI.md) — the single operator entrypoint                                                             |
| Bumping the Interchange pin / vendored code            | [`VENDORED.md`](VENDORED.md) — every vendored `@intx/*` change (files + `@workbench/workflow-host`) and when it was added   |
| Setting up / following engineering rules               | [`../AGENTS.md`](../AGENTS.md)                                                                                              |
| Deploying / running coverage                           | [`../README.md`](../README.md)                                                                                              |

## Scope: root docs vs. package docs

- **Root docs (`docs/`, `AGENTS.md`, `README.md`, `PRODUCT.md`)** cover product,
  architecture, and cross-package decisions, and summarize durable choices.
- **Package docs (`packages/<name>/README.md`)** cover that package's local
  contract and implementation specifics. Root docs link to them for detail
  instead of restating it.
- Use `/scribe` for docs work in either scope — the distinction is scope, not
  ownership.

## Package docs

- `packages/agents/README.md` — agent definitions, templates, and the
  hub-seeded template architecture
- `packages/gtm-workflows/README.md` — artifact-eligibility helpers (which
  artifact kinds each workflow kind accepts as a source)
- `workflows/<kind>/` — native `@intx/workflow` definition packages
  (`@workbench/workflow-<kind>`), one per workflow kind; deployed via the admin
  CLI's **Local actions → Push a workflow** (see `ADMIN_CLI.md`)
- [`WORKFLOWS.md`](WORKFLOWS.md) — the authoritative workflow execution model
  (single-supervisor + in-process child, launch no-op, hub-RPC tool rail),
  divergences from Interchange, the vendored surface, and upstream convergence
- [`DEPLOYING_WORKFLOWS.md`](DEPLOYING_WORKFLOWS.md) — how a workflow is authored,
  pushed, deployed, and run on the native runtime
- `packages/tools-*/README.md` — individual hub tool packages (Gamma, Granola,
  Firecrawl, Exa, …) and their credential resolution
