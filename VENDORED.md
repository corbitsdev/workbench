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
@ `0a4eb59` (origin/main, v0.5.0).

| Vendored path                 | What it is                                                              | Owner  | Kill date  |
| ------------------------------ | ------------------------------------------------------------------------ | ------ | ---------- |
| `apps/sidecar`                 | Copy of upstream's sidecar app; apps are never npm-published. Local delta: `bin/workflow-child` and `bin/workflow-probe-child` run under plain `bun` instead of upstream's `intx-src` resolve condition (the substrate-factory and deploy-router wiring moved to `@intx/workflow-host` upstream) | maintainers | 2026-11-17 |
| `vendor/intx/agent`            | `@intx/agent` at a newer commit than npm has published                    | maintainers | 2026-11-17 |
| `vendor/intx/authz`            | `@intx/authz` at a newer commit than npm has published                    | maintainers | 2026-11-17 |
| `vendor/intx/db`                | `@intx/db`, with local fork migrations (wire_projection, launch origin, tolerate rewrite, tenant slug check, plus upstream 0095–0110 renumbered to 0100–0115) and an openai-responses catalog id | maintainers | 2026-11-17 |
| `vendor/intx/harness`           | `@intx/harness` at a newer commit than npm has published                  | maintainers | 2026-11-17 |
| `vendor/intx/hub-agent`         | `@intx/hub-agent`, with local childRunId event threading                  | maintainers | 2026-11-17 |
| `vendor/intx/hub-api`           | `@intx/hub-api`, with the local workflow-deploy-bearer route              | maintainers | 2026-11-17 |
| `vendor/intx/hub-sessions`      | `@intx/hub-sessions`, with local childRunId event threading and prepared-deploy step staging | maintainers | 2026-11-17 |
| `vendor/intx/inference`         | `@intx/inference`, with one local Google file-upload compile fix          | maintainers | 2026-11-17 |
| `vendor/intx/mail-memory`       | `@intx/mail-memory` at a newer commit than npm has published              | maintainers | 2026-11-17 |
| `vendor/intx/mailbox`           | `@intx/mailbox`, never yet published to npm                               | maintainers | 2026-11-17 |
| `vendor/intx/mime`              | `@intx/mime` at a newer commit than npm has published                     | maintainers | 2026-11-17 |
| `vendor/intx/types`             | `@intx/types`, with local childRunId, openai-responses plugin id, and `formatSafetyRatingText` re-export on `./runtime` | maintainers | 2026-11-17 |
| `vendor/intx/hub-common`        | `@intx/hub-common` at a newer commit than npm has published               | maintainers | 2026-11-17 |
| `vendor/intx/workflow`          | `@intx/workflow`, with one local step-timeout-budget delta                | maintainers | 2026-11-17 |
| `vendor/intx/workflow-deploy`   | `@intx/workflow-deploy` at a newer commit than npm has published          | maintainers | 2026-11-17 |
| `vendor/intx/workflow-host`     | `@intx/workflow-host`, with local childRunId event threading, `@corbits/credential-header` and `@corbits/credential-mcp` provider registration + closure director loading in `child/substrate-factory.ts`, and a temporary delta omitting an empty inbound `Subject` header instead of passing it through empty (kill condition: upstream tolerates an empty Subject, INTR-577) | maintainers | 2026-11-17 |

Every row above is re-vendored at the same commit rather than mixed pins
(npm's `0.5.0` is `d89f87c`; `0a4eb59` is `origin/main` HEAD; rows with no
local delta are un-vendoring candidates); the root
`package.json` `overrides` point each vendored name at `workspace:*` so
their own `@intx/*` dependencies resolve onto the vendored copies too.
Local deltas are restated in each package's own `VENDORED-FROM` file.

## Un-vendoring `vendor/intx`

- [ ] Delete `vendor/intx/` and remove it from the root `package.json`
      workspaces.
- [ ] Restore the `@intx/*` dependencies in `apps/*` and `packages/*` to
      the published npm version, and drop the root `overrides` pins.
- [ ] Delete the `vendor/intx/*` ledger rows above.
- [ ] `bun install`
- [ ] `bun run check`
