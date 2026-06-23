# @workbench/tools-last30days

Native Interchange tool package for the stateless last30days core tools:
`last30days_core_extract`, `last30days_core_report`, `last30days_validate`.

- Keyless — pure functions over `@workbench/last30days-core`; no credential, no
  hub context, no `requires`.
- `src/interchange-tools.ts` exports the `defineTool` factory the sidecar loads
  from the published tarball.
- The hub's `LAST30DAYS_CORE_HUB_TOOLS` (proxy fallback during coexistence)
  re-exports these tools rather than carrying its own copy.

Pinned on Larry. See `docs/CREATING_AGENTS_AND_TOOLS.md` for the tool-package
model and the build/push flow.
