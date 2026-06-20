# @workbench/gtm-workflows

Artifact-eligibility helpers shared between the hub and web app. Workflows themselves are native `@intx/workflow` packages under `workflows/<kind>/` and are deployed via the admin CLI (`bun run admin` → "Local actions → Push a workflow"; see `docs/ADMIN_CLI.md` and `docs/DEPLOYING_WORKFLOWS.md`) — this package no longer holds workflow definitions or a registry.

- This package exports only `artifact-eligibility` helpers — keep it execution-free
- To add or change a workflow, edit the relevant `workflows/<kind>/` package, not this one
- New artifact-eligibility rules: edit `src/artifact-eligibility.ts` and its tests

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
