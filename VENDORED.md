# Vendored code

This file is the ledger of every vendored path in the repository. Workbench
consumes third-party code as published packages; vendoring is a sanctioned
escape hatch for the rare case where a needed capability is not published —
never a convenience.

## Rules

- Vendoring is hand-copied files only — never a git submodule.
- Every vendored path has exactly one row in the ledger below. Code copied into
  the tree without a ledger row is not vendored; it is a bug.
- Every entry carries a **kill date** — the date by which the vendored copy is
  replaced by a published package or deliberately renewed.
- The ledger row and the kill date land in the same commit as the copied
  files.
- Local changes to vendored code land in this repository through normal
  review. The upstream repository is never modified, committed to, or pushed
  to.
- Retiring a vendored copy closes the entry: delete the row and the files
  together.

## Ledger

Pinned to [faremeter/interchange](https://github.com/faremeter/interchange)
@ `79adc433` (origin/main).

| Vendored path                 | What it is                                                              | Owner  | Kill date  |
| ------------------------------ | ------------------------------------------------------------------------ | ------ | ---------- |
| `apps/sidecar`                 | Byte-identical copy of upstream's sidecar app; apps are never npm-published | sawyer | 2026-11-03 |
| `vendor/intx/agent`            | `@intx/agent` at a newer commit than npm has published                    | sawyer | 2026-11-03 |
| `vendor/intx/db`                | `@intx/db`, with one local serving-time credential-refresh delta          | sawyer | 2026-11-03 |
| `vendor/intx/harness`           | `@intx/harness` at a newer commit than npm has published                  | sawyer | 2026-11-03 |
| `vendor/intx/hub-agent`         | `@intx/hub-agent`, with a local OAuth-login-over-websocket delta          | sawyer | 2026-11-03 |
| `vendor/intx/hub-api`           | `@intx/hub-api`, with local approval and workflow-deploy-bearer routes    | sawyer | 2026-11-03 |
| `vendor/intx/hub-sessions`      | `@intx/hub-sessions`, with several local run/pack-acceptance fixes        | sawyer | 2026-11-03 |
| `vendor/intx/inference`         | `@intx/inference`, with one local Google file-upload compile fix          | sawyer | 2026-11-03 |
| `vendor/intx/mail-memory`       | `@intx/mail-memory` at a newer commit than npm has published              | sawyer | 2026-11-03 |
| `vendor/intx/mailbox`           | `@intx/mailbox`, never yet published to npm                               | sawyer | 2026-11-03 |
| `vendor/intx/mime`              | `@intx/mime` at a newer commit than npm has published                     | sawyer | 2026-11-03 |
| `vendor/intx/types`             | `@intx/types`, with one local model-provider-plugin enum addition         | sawyer | 2026-11-03 |
| `vendor/intx/hub-common`        | `@intx/hub-common` at a newer commit than npm has published               | sawyer | 2026-11-03 |
| `vendor/intx/workflow`          | `@intx/workflow`, with one local step-timeout-budget delta                | sawyer | 2026-11-03 |
| `vendor/intx/workflow-deploy`   | `@intx/workflow-deploy` at a newer commit than npm has published          | sawyer | 2026-11-03 |
| `vendor/intx/workflow-host`     | `@intx/workflow-host`, with one local step-grants-collapse delta          | sawyer | 2026-11-03 |

npm's published `0.3.0` predates this pin for every row above, so each is
re-vendored at the same commit rather than mixed pins; the root
`package.json` `overrides` point each vendored name at `workspace:*` so
their own `@intx/*` dependencies resolve onto the vendored copies too.
Local deltas are restated in each package's own `VENDORED-FROM` file.

## Un-vendoring `vendor/intx`

- [ ] Delete `vendor/intx/` and remove it from the root `package.json`
      workspaces.
- [ ] Restore the `@intx/*` dependencies in `apps/*`, `packages/*`, and
      `workflows/*` to the published npm version, and drop the root
      `overrides` pins.
- [ ] Delete the `vendor/intx/*` ledger rows above.
- [ ] `bun install`
- [ ] `bun run check`
