# Spec: Linear GraphQL expansion (CL-3592–CL-3610)

## Objective

Wire modular `packages/tools-linear` domain files into `LINEAR_HUB_TOOLS`, restore full test suite, regenerate hub manifests, update agent phrases and bootstrap writes, document surface in `docs/LINEAR_TOOLS.md`, pass repo CI.

## Worktree

`worktrees/expand-linear-graphql-api` on branch `expand-linear-graphql-api`.

## Done when

- 40+ `linear_*` hub tools registered with correct read/write classification
- `bun test --isolate` in `packages/tools-linear` passes
- `cd apps/hub && bun run build:tool-manifests` committed
- `friendly-tool-summary` + `WRITE_BARE_TOOLS` updated for all writes
- `docs/LINEAR_TOOLS.md` with unsupported-op matrix
- Root `bun run format && lint && typecheck && test` passes

## Constraints

- Keep `linear_create_issue` name; no stubs; arktype at args boundary
- Single PR for all eleven Linear issues
