# @workbench/tools-last30days

Native Interchange tool package for the stateless last30days core tools:
`last30days_core_extract`, `last30days_core_report`, `last30days_ground_queries`,
`last30days_workflow_brief`, `last30days_validate`.

- Keyless — pure functions over `@workbench/last30days-core`; no credential, no
  hub context, no `requires`.
- `src/interchange-tools.ts` exports the `defineTool` factory the sidecar loads
  from the published tarball.
- The hub's `LAST30DAYS_CORE_HUB_TOOLS` (proxy fallback during coexistence)
  re-exports these tools rather than carrying its own copy.

Pinned by the `last30days-research` workflow:

- `last30days_ground_queries` parses the grounding step's JSON reply into a
  per-source query map (object `content`) so each source fan-out searches a query
  tailored to its platform; every source key is guaranteed a non-empty string,
  falling back to the base query when the grounding reply omits or blanks it.
- `last30days_workflow_brief` folds the source step outputs into a `buildReport`
  brief (passing a `minRelevance` floor so off-topic clusters are dropped rather
  than padding the result).

Intake sends a single `query` string (focus or topic) from the UI — the grounding
step expands it per platform; there is no separate normalize step.

After changing this package or `workflows/last30days-research`, ship to staging:

1. Deploy hub + sidecar images that include the commit (normal release pipeline).
2. From repo root: `bun run admin:staging` → sign in → select tenant → **Workflows**
   → **Push (deploy)** → `last30days-research`. That rewrites `workflow.json`,
   refreshes tool pins on step agents, and re-establishes the supervisor.
3. Start a **new** run in the UI (in-flight runs keep the old definition).

See `docs/DEPLOYING_WORKFLOWS.md` for the workflow deploy model.
