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
  replaced by a published package or deliberately renewed — and a dated test
  that fails after that date. An entry with no kill date is not an entry.
- The ledger row, the kill date, and its dated test land in the same commit as
  the copied files.
- Local changes to vendored code land in this repository through normal review.
  The upstream repository is never modified, committed to, or pushed to.
- Retiring a vendored copy closes the entry: delete the row, the files, and the
  kill-date test together.

## Ledger

| Vendored path                 | What was copied                                                                | Upstream repo @ commit                                                         | Why not a published package                                                                                                                                                        | Owner  | Kill date  | Kill-date test    |
| ----------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- | ----------------- |
| `vendor/intx/agent`           | `@intx/agent` source (`src/`, manifest, tsconfig)                              | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/authz`           | `@intx/authz` source (`src/`, manifest, tsconfig)                              | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/crypto`          | `@intx/crypto` source (`src/`, manifest, tsconfig)                             | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/db`              | `@intx/db` source (`src/`, `migrations/`, drizzle config, manifest, tsconfigs) | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/harness`         | `@intx/harness` source (`src/`, manifest, tsconfig)                            | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/hub-agent`       | `@intx/hub-agent` source (`src/`, manifest, tsconfig)                          | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/hub-api`         | `@intx/hub-api` source (`src/`, manifest, tsconfig)                            | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/hub-common`      | `@intx/hub-common` source (`src/`, manifest, tsconfig)                         | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/hub-sessions`    | `@intx/hub-sessions` source (`src/`, manifest, tsconfig)                       | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it, or by an upstream `inference.usage`-carrying event stream (CL-5879, whichever lands first) | sawyer | 2026-09-05 | `check:killdates` |
| `vendor/intx/inference`       | `@intx/inference` source (`src/`, manifest, tsconfig)                          | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/log`             | `@intx/log` source (`src/`, manifest, tsconfig)                                | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/mail-memory`     | `@intx/mail-memory` source (`src/`, manifest, tsconfig)                        | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/mime`            | `@intx/mime` source (`src/`, manifest, tsconfig)                               | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/pack-transport`  | `@intx/pack-transport` source (`src/`, manifest, tsconfig)                     | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/storage-isogit`  | `@intx/storage-isogit` source (`src/`, manifest, tsconfig)                     | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/tool-packaging`  | `@intx/tool-packaging` source (`src/`, manifest, tsconfig)                     | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/types`           | `@intx/types` source (`src/`, manifest, tsconfig)                              | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/workflow`        | `@intx/workflow` source (`src/`, manifest, tsconfig)                           | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/workflow-deploy` | `@intx/workflow-deploy` source (`src/`, manifest, tsconfig)                    | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/workflow-host`   | `@intx/workflow-host` source (`src/`, manifest, tsconfig)                      | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |

The pinned commit `59f5e7b9` is the tip of upstream `main` as of 2026-08-18,
a plain main-tip bump from `55c4431e`. The 32 commits it adds are the
source-format workflow line — workflow definitions and tool packages
resolved from a hub asset's git tree rather than a packed tarball, with a
monorepo-aware closure resolver, an atomic materialized asset store, and
pack-boundary limits (object count, per-object inflation, symlink and
submodule rejection). No published `@intx/*` version yet covers any
vendored path: npm still tops out at `0.2.2`, which predates the folded
model, so every row below stays vendored.

Local modifications (all `vendor/intx/*` rows): each package's exports map
is repointed from the upstream `intx-src` resolve condition to direct
TypeScript source resolution (`types`/`default` → `./src/...`), with `dist/`
references and the `customConditions` entry in the shared tsconfig removed —
workbench forbids custom resolve conditions; `vendor/intx/harness` drops the
unvendored `@intx/inference-testing` devDependency and `vendor/intx/hub-agent`
drops the unvendored `@intx/test-harness` devDependency; `vendor/intx/hub-api`
adds a `@types/ssri` devDependency that bun's isolated linker does not hoist
from tool-packaging the way upstream's install does, and its approval param
routes exclude the reserved segment `needs-you` so hosts can mount a sibling
`/approvals/needs-you` list without `/:approvalId` capturing it;
`vendor/intx/hub-sessions` (CL-5879) forwards `inference.usage` events —
previously matched by `event-collector.ts`'s "not persisted" default and
dropped — to a new optional `onUsage` callback on `createEventCollector`
and `createEventCollectorRegistry`, carrying `{turnId, model, usage}` plus
the registry's own `tenantId`/`sessionId`; no new persistence lands in the
vendored copy itself, only the forward, and `apps/hub/src/index.ts` wires
it to `@corbits/insights`' `createUsageSink` so `usage_turn` rows are
written for the first time. Each package's `VENDORED-FROM` file restates
its own delta.

### Un-vendoring `vendor/intx`

- [ ] Delete `vendor/intx/` and remove `vendor/intx/*` from the root
      `package.json` workspaces.
- [ ] Restore the `@intx/*` dependencies in `apps/*`, `packages/*`, and
      `workflows/*` to the published npm version that covers the vendored
      surface.
- [ ] Delete the twenty ledger rows above and the local-modifications note.
- [ ] Drop the `vendor/intx/*` rows from `scripts/checks/kill-dates.txt`.
- [ ] `bun install`
- [ ] `bun run check`
