# 3d-manifest_phrases_bootstrap

## Tasks

1. `cd apps/hub && bun run build:tool-manifests` — commit generated manifests if changed.
2. Extend `packages/agents/src/friendly-tool-summary.ts` PHRASES for every `linear_*` tool in `hub-tools.ts` (short present-tense strings).
3. Extend `packages/agents/src/bootstrap.ts` WRITE*BARE_TOOLS for all write `linear*\*` tools.
4. Update `packages/agents/src/friendly-tool-summary.test.ts` if needed.
5. Run `bun test --isolate` in packages/agents and packages/tools-linear.

## Commit

`linear tools: regenerate manifests and agent phrases for expanded surface`
