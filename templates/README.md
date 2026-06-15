# templates

Copy-me scaffolds for new Workbench packages. These are **not** Bun workspace
members — the root `package.json` `workspaces` globs cover `packages/*`, not
`templates/*` — so they are excluded from build, typecheck, lint, test, and
coverage gates.

- `tool-agent/` — starting point for a new agent package (`@workbench/agent-rename-me`).
- `tool-template/` — starting point for a new tool package (`@workbench/tools-rename-me`).

To use one: copy the directory into `packages/<your-name>`, rename the package
in its `package.json` (drop the `-rename-me` suffix), and `bun install` to pick
it up as a workspace member.
