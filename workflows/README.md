# workflows/

Native workflow definitions, authored as packages and pushed to a running hub
as git-backed assets.

## Convention

Each workflow lives at `workflows/<kind>/` as its own package named
`@workbench/workflow-<kind>`. A package exports exactly two things:

- `kind` — the workflow kind string (matches the directory name)
- `workflow` — a `defineWorkflow(...)` definition from `@intx/workflow`

The hub **never imports** these packages. They are git-backed assets: the push
script serializes a definition to JSON and posts it to the hub, which commits it
to a `workflow` repo and launches it on the sidecar. Adding a workflow is a new
package plus a push — no hub or push-script change.

## Adding one

1. Create `workflows/<kind>/` as `@workbench/workflow-<kind>` exporting `kind`
   and `workflow` (copy `collateral-generation` as a template).
2. `bun install` to register the workspace member.
3. Push it via the admin CLI: `bun run admin` (or `admin:staging` /
   `admin:production`) → select a tenant → "Local actions (build, seed, push)" →
   "Push a workflow". At the "Workflow kind (e.g. pain-point-collateral)" prompt,
   type just the kind value (e.g. `<kind>`); the selected tenant is threaded
   automatically.

## Serialization constraint

Because the definition crosses the wire as JSON, every step agent must express
its tools via serializable `capabilities` (and an optional `director` ref) —
never inline tool factories, which vanish through `JSON.stringify`.

See [../docs/ADMIN_CLI.md](../docs/ADMIN_CLI.md) for the operator entrypoint, and
[../docs/DEPLOYING_WORKFLOWS.md](../docs/DEPLOYING_WORKFLOWS.md) for the deploy
flow, authorization, and required credentials.
