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

| Vendored path                   | What was copied                                                                                                                                                                                                                                                                                                                                 | Upstream repo @ commit                                                         | Why not a published package                                                                                                                                                        | Owner  | Kill date  | Kill-date test    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- | ----------------- |
| `apps/sidecar`                  | Derived from upstream's own `apps/sidecar`: 11 shared modules, of which `signing-keypair.ts` is near-verbatim and the rest (`index.ts`, `config.ts`, `tool-materialization.ts`, `workflow-run-pack-client.ts`, …) are substantially rewritten, plus workbench-only modules. A living fork, not a frozen copy, so this row carries no tree hash. | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | An app is never npm-published, so no publish can cover the execution host; retired by consuming an upstream-published host, or by renewing this row deliberately                   | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/agent`             | `@intx/agent` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                               | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/authz`             | `@intx/authz` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                               | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/crypto`            | `@intx/crypto` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                              | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/db`                | `@intx/db` source (`src/`, `migrations/`, drizzle config, manifest, tsconfigs)                                                                                                                                                                                                                                                                  | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/harness`           | `@intx/harness` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                             | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/hub-agent`         | `@intx/hub-agent` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                           | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/hub-api`           | `@intx/hub-api` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                             | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/hub-common`        | `@intx/hub-common` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                          | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/hub-sessions`      | `@intx/hub-sessions` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                        | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it, or by an upstream `inference.usage`-carrying event stream (CL-5879, whichever lands first) | sawyer | 2026-09-05 | `check:killdates` |
| `vendor/intx/inference`         | `@intx/inference` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                           | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/inference-catalog` | `@intx/inference-catalog` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                   | [faremeter/interchange](https://github.com/faremeter/interchange) @ `5d2aa94a` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/log`               | `@intx/log` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                 | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/mail-memory`       | `@intx/mail-memory` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                         | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/mime`              | `@intx/mime` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/pack-transport`    | `@intx/pack-transport` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                      | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/storage-isogit`    | `@intx/storage-isogit` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                      | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/tool-packaging`    | `@intx/tool-packaging` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                      | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/types`             | `@intx/types` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                               | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/workflow`          | `@intx/workflow` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                            | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/workflow-deploy`   | `@intx/workflow-deploy` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                     | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/workflow-host`     | `@intx/workflow-host` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                       | [faremeter/interchange](https://github.com/faremeter/interchange) @ `59f5e7b9` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |

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
and `createEventCollectorRegistry`, carrying `{turnId, provider, model, usage}` plus
the registry's own `tenantId`/`sessionId`; no new persistence lands in the
vendored copy itself, only the forward, and `apps/hub/src/index.ts` wires
it to `@corbits/insights`' `createUsageSink` so `usage_turn` rows are
written for the first time. `vendor/intx/hub-sessions` also drops the
live-status gate on `receiveWorkflowRunPack`'s anchor lookup: the gate is now
the exported pure helper `ownsWorkflowRunRepo` (a self-anchored `workflow_run`
row with a routable address), with the allocation fences unchanged. Upstream
required `status in (deployed, running)`, which wedged every terminal run that
still had mail in flight into a permanent loop — the run's own inbox-enqueue
and `markConsumed` rejection packs were refused as `path_violation`, the
sidecar withheld the ack, and the hub redelivered forever
(`docs/revendor-inventory.md`). `vendor/intx/workflow-host` (CL-6164) drops
inbound mail carrying no conversation text on the parked-resume path rather
than delivering an empty string that throws inside `agent.send` and fails the
step with `retriesExhausted`; the gate is the new pure helper
`hasConversationText`. `vendor/intx/workflow-host` (CL-6325) additionally
carries three adapter files (`adapters/action-invoker.ts`,
`adapters/effect-ledger.ts`, `adapters/run-blobs.ts`, plus their tests) that
are NOT from upstream faremeter/interchange at all — upstream's own
`packages/workflow-host` has no action-primitive adapters at the pinned
commit. They are copied from gtm-workbench's own `packages/workflow-host`
workspace fork (see `docs/revendor-inventory.md` for the full provenance
note and why no ordinary upstream-publish kill date applies to this
sub-delta). `vendor/intx/workflow` (CL-6326) adds an
`onBodyFailure` policy field to the `onTrigger` primitive: absent (or
`"end"`) preserves terminal-is-final exactly as before, `"continue"` lets a
body run that ends `failed` (never `cancelled`) leave the section
subscribed instead of ending the whole run, so one bad turn does not kill a
long-lived section. The gate is read live off `primitive.onBodyFailure` at
both the steady-state drive loop and the crash-recovery resume plan in
`runtime/run.ts`, mirroring how `awaitSignal.onTimeout` is read live rather
than defaulted at construction. This delta targets the current pin
(`59f5e7b9`) and re-applies against the re-pinned tree once PR #59 lands —
see `docs/revendor-inventory.md`. `vendor/intx/inference-catalog` (CL-6280) is
pinned separately at `5d2aa94a`, a later `main` tip than the other twenty
rows' `59f5e7b9`, since that commit is where the package's folded
provider/model catalog first landed upstream; its own local modification
also repoints the `./models` subpath's exports, not just the root export.
Each package's `VENDORED-FROM` file restates its own delta.

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
