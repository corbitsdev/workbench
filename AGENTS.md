# AGENTS.md

## Session Start

1. Read this file
2. Read `PRODUCT.md` (the product entrypoint), which points to the canonical
   `docs/PRODUCT.md`; see `docs/README.md` for the full doc index and which
   doc to read for a given task
3. Do not proceed until these steps are complete

## Project

GTM Workbench is an AI-assisted GTM workspace built on top of Interchange. Users get a personal agent (Myra), shared workspace agents (Oat, others), and workflows for turning call data into publishable collateral. For current product and architecture details, read the scribe-managed docs.

Operators run all tenancy, credential, tool, and workflow operations through the admin CLI — `bun run admin` / `admin:staging` / `admin:production` (`apps/hub/bin/admin/`); see `docs/ADMIN_CLI.md`.

### Monorepo layout

- `interchange/` — Interchange dependency. Do not modify.
- `apps/web/` — React 19 + Vite + Tailwind CSS. Human-facing UI.
- `apps/hub/` — Hono + TypeScript. Backend, pipeline, persistence.
- `apps/sidecar/` — Interchange sidecar runtime.
- `packages/` — Shared packages (`@workbench/*`).
- `interchange/packages/` — Interchange packages (`@intx/*`).

### Apps stay generic; packages own the domain

Domain knowledge — workflow definitions, status vocabularies, credential requirements, prompts, artifact kinds, business rules — lives in `packages/*`. Apps are thin hosts: wire HTTP routes, render UI, delegate every product decision to a package. If you find yourself encoding a product rule inside `apps/web` or `apps/hub`, it belongs in a package.

### Stack

- Bun (1.2+), Hono, TypeScript, Drizzle ORM, PostgreSQL (port 5433)
- Frontend: React 19, Vite, Tailwind CSS, Framer Motion
- Agent runtime: `@intx/agent`

## Interchange Is the Operating System

Every agent lifecycle operation, credential flow, session, grant, and inference call goes through Interchange. Stop and read Interchange before writing anything in these domains.

### Mandatory lookup before implementing

1. `interchange/docs/` — AUTH.md, ARCHITECTURE.md, CREDENTIALS.md, MESSAGE.md, API.md
2. `interchange/packages/` — search the relevant package source
3. Check exports of `@intx/hub-common`, `@intx/db`, `@intx/types`, `@intx/hub-api`, `@intx/hub-sessions`
4. Only implement from scratch if Interchange genuinely does not cover it — explain why in the PR

### What Interchange owns — never reimplement

| Domain                  | What Interchange does                                                                        | Where to look                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Credential resolution   | Resolves from tenant hierarchy by `providerName` + `source` + optional `name`                | `@intx/db` → `resolveCredentialRequirement`, `resolveOneCredential` |
| Agent launch            | Resolves `credentialRequirements` → builds inference sources → launches via sidecar          | `@intx/hub-sessions` → `SessionService.launchSession`               |
| Credential requirements | Interchange resolves them at launch; `source: 'tenant'` = tenant-owned (`principalId: null`) | `@intx/types` → `CredentialRequirement`                             |
| Grant resolution        | Collects all grants for a principal including role-based grants                              | `@intx/db` → `createGrantStore` → `collectGrants`                   |
| Session orchestration   | Session lifecycle, sidecar registration, reconnect                                           | `@intx/hub-sessions` → `createHubSessionOrchestrator`               |
| ID generation           | Typed, prefixed IDs for every entity                                                         | `@intx/hub-common` → `generateId`                                   |
| LLM inference           | All inference calls go through the agent runtime                                             | `@intx/agent` — never direct fetch to LLM endpoints                 |
| DB schema + types       | Tables, ID formats, row types                                                                | `@intx/db/schema`, `@intx/types`                                    |

### Credential + launch pattern

```ts
// Agent definition — declare what you need
credentialRequirements: [{ providerName: 'openai-compatible', source: 'tenant', name: 'Myra LLM' }]
// Credential — tenant-owned, not principal-owned
{ principalId: null, tenantId, providerId, name: 'Myra LLM', ... }
// Launch — no credentialIds; Interchange resolves from requirements
sessionService.launchSession({ agentId, instanceId, ... })
```

### Agent credentials vs tool credentials

- `credentialRequirements` are **inference-only**. Tool-only providers (`firecrawl`, `granola`, `exa`, `xai`, `reddit`, `scrapecreators`) must NOT go in `credentialRequirements` — they break sidecar launch with `Source provider "X" is not registered`.
- For tool credentials: add the `providerName` to `credentialProviderNames` on the deploy descriptor; resolve at tool execution time via `resolveCredentialRequirement` in the hub tool registry.
- Third-party generation APIs (e.g. Gamma): direct HTTP from a hub tool is fine; resolve the key via `resolveCredentialRequirement`; document in the package README.

## Worktree Setup

```bash
git submodule update --init   # Interchange submodule is not auto-initialized
bun install                   # node_modules are not shared between worktrees
```

**`intx-src` resolution condition** — every `tsconfig.json` in the repo (root, every `apps/*`, every `packages/*`, every `workflows/*/`) declares `customConditions: ["intx-src"]`, and `bun`/`vite` need the same condition passed at runtime for `@intx/*` imports to resolve against interchange source rather than a built package. This is wired repo-wide already (root + member `bun` scripts pass `BUN_OPTIONS=--conditions=intx-src`, `apps/hub`/`apps/sidecar` Dockerfiles set it as an `ENV`, `apps/web`'s Vite config sets `resolve.conditions`), so a fresh worktree needs no extra setup beyond `bun install` above — the scripts pick the condition up automatically. If you add a **new** workspace member (a new `tsconfig.json`), it needs `customConditions: ["intx-src"]` too, matching every other tsconfig in the repo — a tsconfig missing it fails `@intx/*` imports with `Cannot find module` under `bun run typecheck` even though the same import resolves fine at the workspace root. `bunfig.toml` cannot set this condition globally (only the `--conditions` flag / `BUN_OPTIONS` applies), so the root `test`/`typecheck` scripts front-run `scripts/preflight-intx-src.ts`, which fails loud with a clear fix message if the condition is not active (run it directly — `bun run preflight:intx-src` — to diagnose a cryptic `@intx/*` resolution error from a hand-run bun command).

## Commit Process

Each step is a separate commit.

1. **Red** — write tests, confirm they fail. Commit: `"Add tests for <feature/fix>"`
2. **Green** — minimal change to pass tests, run full build pipeline. Commit: `"<feature/fix>: <what changed>"`
3. **Docs** — run the scribe skill if product/architecture/implementation docs are affected. Commit: `"Update docs: <what changed>"`

- One logical change per commit; messages describe the change, not the task
- Never auto-commit; present the message and wait for confirmation

## Versioning

Deployed release semver lives in the **root** `package.json` only. Workspace members keep their own versions unless a package is independently published.

| Merge target                          | When                                               | Bump                                                              |
| ------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| **`staging`** (feature/fix PR)        | Last commit on the PR branch, **before** merge     | **patch** — `npm version patch --no-git-tag-version` at repo root |
| **`main`** (staging → main promotion) | On `staging` before the release PR merges          | **minor** — `npm version minor --no-git-tag-version` at repo root |
| **`main`** (hotfix)                   | Last commit on the hotfix branch, **before** merge | **patch** only — do **not** bump minor                            |

- Commit message for any version-only change: `chore: release <version>`.
- Do not create git tags unless release ops explicitly asks; the version field is what production builds read.
- Staging → main release PRs should name the target version in the title and body (and link Linear issues), consistent with prior promotion PRs.

## Testing

**Coverage is a floor, never the goal. We want the highest _meaningful_ coverage — never coverage for its own number.** A test earns its place by being able to fail when the behavior breaks. If a test cannot fail for a real reason, it is worse than no test: it is green noise that hides the gap. So:

- **Maximize real coverage, not the percentage.** Chase the untested behavior that matters; do not write a test purely to move the number.
- **A useless test is a bug.** If a test asserts nothing that could break (tautology, asserts the mock, render-without-crash, exercises a line without checking its effect), either rewrite it to assert real behavior or delete it. Do not keep it for the %.
- **Do it right or don't do it.** Half a test that pretends a path is covered is more dangerous than an honest gap. If you can't test it properly yet, leave it untested and say so (in the PR / a ticket) rather than faking it.
- **Mocking the boundary you depend on can make a green suite that proves nothing about the integrated system.** Unit tests that mock `@intx/*` prove the pieces, not the machine. Any critical end-to-end path (e.g. workflow start → run → step execution → artifact) MUST have at least one integration test that exercises the real components across their seams — that is where the bugs that make the app "useless while green" actually live. A subsystem whose only failure mode is a seam between mocked components is, by definition, untested.

- **80% merged line coverage is a hard floor**, not a target. Measure with `bun run coverage`. Never let a change drop below it — but clearing 80% with hollow tests does not satisfy this rule.
- Every package with runnable code must define `test` and `test:coverage` scripts. Pure type-only packages exempt (document it).
- Assert behavior, not execution — no tautologies, no render-without-crash tests.
- `screen.getByText('X')` throws if absent — do not append `.toBeDefined()`.
- Never assert the mock. A test that checks a value it fed to a mock proves nothing.
- Mock only at the `@intx/*` or a true module boundary via `mock.module(...)`.
- Run the suite with `bun test --isolate` (a fresh global per test file). `mock.module(...)` is process-global in bun, so without isolation a mock from one file leaks into another — the usual cause of a test that passes alone but fails in the full run. If a test passes in isolation but fails in the suite, suspect mock leakage, not a product bug.

## Build Requirements

```bash
bun run format && bun run lint && bun run typecheck && bun run test
```

`bun run format` formats only changed files (staged + unstaged + untracked). Use `bun run format:all` to format the entire repo explicitly.

`bun run typecheck` must pass with zero errors in `apps/`, `packages/`, `scripts/` before any commit. Errors inside `interchange/` are pre-existing upstream issues.

## Dockerfile Maintenance

Each image uses a targeted `COPY` list. When you add/remove/rename a package or app:

- New `packages/*` dep → add `COPY packages/<name>/` and `COPY packages/<name>/package.json` in every image that depends on it.
- Removed package → remove its lines from all Dockerfiles.
- **Manifests vs source — two different lists, two different rules:**
  - The manifest-copy section (`COPY <member>/package.json` before `bun install`) **must list every workspace member**, in every image. `bun.lock` is workspace-global; `--frozen-lockfile` compares the on-disk member set against the lockfile and fails with `lockfile had changes` if any recorded member's manifest is missing — even members the image never imports. (Members without a `package.json`, e.g. scaffold dirs, are not in the lockfile and are correctly omitted.)
  - The full-source COPY section (after `bun install`) lists **only the image's runtime closure**. The **sidecar copies no `@workbench/tools-*` source** — tool packages reach it as registry tarballs at launch (the package-registry substrate), not through its image. Do not add tool source to the sidecar image.
- **Interchange pin SHA** — each image clones interchange at a hardcoded commit (the `git -C interchange checkout <sha>` line). When you bump the `interchange` submodule pin, bump that SHA in all three Dockerfiles too (`apps/hub`, `apps/sidecar`, `apps/web`), or `bun install --frozen-lockfile` validates against the wrong `@intx/*` graph and the build fails.
- **Bun version** — keep `FROM oven/bun:<ver>` in the three images aligned with the bun that authored `bun.lock` (general hygiene; relock and bump together).
- **Interchange undeclared hoisted deps** — `@intx/agent` now declares `@intx/log` upstream, so the former root-`package.json` force-hoist of `@intx/log` has been removed. If another interchange package ever imports an `@intx/*` dep it does not declare (symptom: `Cannot find module @intx/<x>` at startup), force-hoist it by declaring it in the **root** `package.json` until interchange declares it upstream.
- **Vendored workflow-host wiring (pin-bump gate)** — `apps/sidecar/src/workflow-host-wiring.ts`, `workflow-substrate-factory.ts`, `workflow-run-pack-client.ts`, and `bin/workflow-child` are copied from interchange's reference `apps/sidecar` (the `createSidecarDeployRouter` supervisor wiring is not packaged in any `@intx/*` — `@intx/workflow-host` ships only the building blocks). They duck-type the `@intx/workflow-host` hand-off, so a contract change won't surface at compile time. As of the `6927e7e4` runtime-retirement pin bump (2026-07-16), single-agent instances (Myra/Oat/triage/gate agents) deploy as **single-step workflow deployments** through this same path — upstream deleted `launchSession` and the in-process per-instance harness runtime with it, so there is no separate launch mechanism left to keep in sync.
  - **`workflow-host-wiring.ts`** carries WORKBENCH-LOCAL blocks for CL-2199 (`TENANT_ID` + `WORKFLOW_RAW_DEPLOYMENT_ID` in the multi-step `substrateEnv` — the workflow-child's `filterSubstrateConfig` throws without both), CL-2231 (`ownedDirs` capture + undeploy-hook reclaim sweep, computed via `sanitizeAddress` imported from `@workbench/hub-agent`), CL-2340 (drain barriers pairing the pack-client's delta-cursor machinery), CL-2363 (`assertSubstrateEnvComplete` guard), CL-2783 (bounded-parallel `writeStepGrants` that drains in-flight writes before propagating the first failure), and CL-3104 (hibernate teardown flavor + resident-supervisor self-heal). **Retired at this bump, not carried forward:** CL-2400 (register-before-spawn ordering — upstream's rewritten reconnect protocol removes the race it guarded against) and CL-3780 (trivial-branch listener disposer — the `trivialLaunch` branch it guarded no longer exists on the single-step-workflow launch path).
  - **`workflow-run-pack-client.ts`** still carries the CL-2340 delta-cursor + size-ceiling machinery (`WorkflowRunPackTooLargeError`, `buildDeltaPack`, ack-gated `lastAckedTip`) that replaces the substrate's `createPack`/`lastPackedTip` path.
  - **`workflow-deployment-record.ts` is DELETED (no boot-time restore)** — added at the `6927e7e4` bump as sidecar-local persistence for re-establishing a deployment across a sidecar process restart, it was removed entirely: the sidecar keeps no deployment memory beyond the workflow-run substrate itself, and `index.ts` no longer restores anything at boot. The hub is the control plane — mail-wake re-deploys idle single-step agents, gate signals plus the awaiting prewarm re-establish parked runs, and the run-liveness sweep fails a running run whose child died with the process — so a freshly-booted sidecar is empty by design. This retires the record's CL-2199 durable substrate-env persistence and the CL-3368 resurrection-guard tombstone with it (nothing is ever restored, so there is nothing left to guard against resurrecting). `apps/sidecar/src/workflow-deployment-dirs.ts` keeps the two pure helpers (`workflowDeploymentDir`, `reclaimWorkflowDeploymentDir`) as a small owned (non-vendored) file; `atomic-write.ts` is now unused. See `docs/VENDORED.md` for the full record.
  - **`workflow-substrate-factory.ts` is an acknowledged FORK** (same discipline as `packages/hub-agent`), now converged onto upstream's tool-resolution model. Upstream `6927e7e4` replaced hub-RPC step-tool resolution with on-disk deploy-tree materialization, and the workbench **adopted it** (hard cutover, 2026-07-17): every deployed agent/step reads its pinned tool closure from the deploy tree the hub stages on disk. The hub-RPC RESOLUTION rail (`/api/internal/tools/manifest`, the sidecar's `fetchStepToolManifest`, the `ToolManifest*` types) is **deleted**; multi-step per-step staging is wired through interchange's `SessionService.stageWorkflowStep` (replacing the `noLaunchStepSession` no-op) in `apps/hub/src/services/workflow-deploy.ts`. What is KEPT as a thin layer AROUND the native loader (NOT the resolution fork): the tool-CREDENTIAL rail (`/api/internal/tools/credentials`), the hub-backed `RuntimeCapabilities` rail (`/api/internal/hub-tools/run`, the `HUB_RPC` context), the per-step grants read, `writeStepAgentRows` (feeds the credential/grants gate), and the `WORKFLOW_RAW_DEPLOYMENT_ID` / `deriveRawDeploymentId` threading (keys those kept rails — it does NOT locate the on-disk tree, which is `mailboxAddress`-derived via `stepDeployTreeDir`). The file's re-sync process stays "merge upstream structure onto the fork branch" (upstream owns the tool-resolution seam now, but the credential/hub-backed injection loop is still ours). Its WORKBENCH-LOCAL tags (CL-2199, CL-2401, CL-2650, CL-3379) are unchanged. See `docs/VENDORED.md` for the full cutover record.
  - On every interchange pin bump: (1) diff these vendored/forked files against `interchange/apps/sidecar/src/*` + `bin/workflow-child` at the new pin and re-apply upstream changes **while re-applying every `WORKBENCH-LOCAL` block**, (2) re-run `bun run --filter @workbench/sidecar test`, and (3) re-verify the `as AgentDeployWorkflow['definition']` cast in `apps/hub/src/services/workflow-deploy.ts` still reflects only exactOptional variance.
  - **Audit is mechanical: `git grep 'WORKBENCH-LOCAL' apps/sidecar/ packages/workflow-host/ packages/inference/ packages/storage-isogit/ packages/hub-agent/'`** lists every divergence in one pass (each block is fronted by a `// WORKBENCH-LOCAL (CL-XXXX)` token). Run it before and after a re-sync and confirm no expected block disappeared — but at a runtime-retirement-class bump, blocks tied to the retired runtime (CL-2535, CL-2537, CL-3102, CL-3103, CL-2400, CL-3415, CL-3796 at this bump) are expected to disappear; cross-check disappearances against `docs/VENDORED.md`'s "RETIRED" notes rather than treating every drop as a regression. **`packages/workflow-host` is a full vendor of `@intx/workflow-host`** (the sidecar imports it instead of upstream) and must be re-synced against the new upstream on every pin bump — its `recoverParkedRun` hook (CL-2535) is gone as of `6927e7e4` because upstream's own resume guard now covers the case. **`packages/storage-isogit` is a 100% verbatim vendor of `@intx/storage-isogit`** (re-copy cleanly on every bump; on-disk pack/repo format must stay parity with what the hub consumes) and **`packages/hub-agent` is an untagged long-lived FORK** (never literally re-copy — see its VENDORED.md entry; its CL-3340 assistant-loop-guard is re-homed onto the sidecar's inference-event path — `apps/sidecar/src/assistant-loop-guard-wiring.ts`, wired into `onInferenceEvent` and the mail-router reset in `workflow-host-wiring.ts`, both `// WORKBENCH-LOCAL (CL-3340)` — after its pre-bump host, the in-process SessionManager's `onEvent` stream, was deleted with the retired runtime. Scoped to `warmKeep` single-step deployments; a trip publishes a synthetic `inference.error{category: "aborted"}` through the existing publish path and calls `supervisor.drain({deadlineMs: 0})` to abort the looping run). The full catalogue of vendored changes (files + package) and when each was added lives in [`docs/VENDORED.md`](docs/VENDORED.md).
  - **Drift script:** `scripts/check-vendored-drift.sh <prior-workbench-ref> [candidate-ref]` prints, per vendored file, every line present in the prior workbench version but ABSENT in the candidate — surfacing dropped WORKBENCH-LOCAL lines for review. It is a manual pin-bump aid (operator-run, not CI-gated). Typical use after re-applying locals onto the new upstream: `scripts/check-vendored-drift.sh origin/staging`.
  - **Duck-typed seams to re-verify on every bump** (these will NOT surface at compile time — the hand-off is duck-typed):
    - **T2 — supervisor / step-invoker contract:** `warmKeep` (single-step warm-keep flag, computed in `workflow-substrate-factory.ts` from `stepOrder.length === 1`), `stepCount` (the real parsed `STEP_COUNT` from `packages/workflow-host/src/child/env-bootstrap.ts`, surfaced as `env.spawn.stepCount`; it MUST be used directly for step-address derivation in `resolveStepToolContext` — never reconstructed from `warmKeep` (`env.spawn.warmKeep ? 1 : 2`), which would mislocate a multi-step deploy tree if a future pin ever set `warmKeep` on a non-single-step deploy), `mailboxAddress` (threaded through `packages/workflow-host/src/child/env-bootstrap.ts`'s `MAILBOX_ADDRESS` env key into `run-child.ts`), and the **4-arg `invokeStep`** signature (`(req, onEvent, authorize, warmCache)`, matched between `RunWorkflowChildBindings["invokeStep"]` in `workflow-substrate-factory.ts` and `ChildStepInvoker` in `packages/workflow-host/src/child/run-child.ts`). An upstream shape change here compiles but mis-wires the step harness.
    - **T3 — inference event discriminants:** `parseInferenceEvent` in `workflow-host-wiring.ts` is imported directly from `@intx/types/runtime` (no local duplicate), and `onInferenceEvent` forwards the whole validated union opaquely to `publishInferenceEvent` rather than switching on individual variants — so a new upstream event type passes through rather than being silently dropped. Re-verify this forwarding stays variant-agnostic on each bump; a future consumer that switches on individual event kinds would reintroduce the drop risk.
    - **T1 — on-disk address mapping:** `sanitizeAddress` (imported from `@workbench/hub-agent`) determines the owned-dirs on-disk layout for the CL-2231 reclaim sweep. Pinned by `workflow-host-wiring-undeploy-reclaim.test.ts`; re-verify the import resolves and the mapping matches what the substrate writes.
    - **T4 — IPC channel fd convention (CL-2585):** the workflow-child's `EVENT_CHANNEL_FD = 3` / `CONTROL_DOWN_FD = 4` / `CONTROL_UP_FD = 5` in `packages/workflow-host/src/child/from-process-env.ts` MUST stay in lockstep with the `Bun.spawn` `stdio` indices in `workflow-host-wiring.ts` `defaultSubprocessSpawner` (`["inherit","inherit","inherit","pipe","pipe","pipe"]` → event on `stdio[3]`, control-down on `stdio[4]`, control-up on `stdio[5]`). The control channel is bidirectional and needs TWO pipes (a single Bun `"pipe"` slot is unidirectional). An upstream re-sync that reverts the control channel to stdin/stdout (or renumbers the fds) compiles but re-introduces the log-corruption crash (`control channel received non-JSON line` → `reason=corrupt`). Guarded by `apps/sidecar/src/workflow-host-wiring-spawner.test.ts` and `packages/workflow-host/src/ipc/control-channel-log-corruption.repro.test.ts`.

## Credential Seeding Maintenance

When you add a `@workbench/tools-*` package with a credential `providerName`:

- Add an entry to `buildEntries()` in `apps/hub/bin/seed-credentials.ts`.
- Add the env var to `.env.example`.
- Add a `buildEntries()` test asserting the entry appears/disappears with the env var.
- Add the `providerName` to the agent's `credentialProviderNames` (never `credentialRequirements`).
- **Add the provider to `CREDENTIAL_PROVIDER_CATALOG` in `packages/workbench-shared/src/governance.ts`** (`kind: "tool"`) so the key can be set/replaced/cleared from the Owner → Capabilities page. The catalog is a hand-maintained list, NOT derived from the tool packages — a new tool credential is invisible in the Owner UI until it is added here. The `surfaces every seeded tool credential` test in `seed-credentials.test.ts` fails if a seeded tool provider is missing from the catalog. If the credential needs more than a secret (an endpoint or identity handle), set `secondaryField`; override `secretLabel` when the secret is not an API key; list the platforms one credential powers via `platforms`.

Keyless tools need no seed entry and no catalog entry — say so in the package README.

## Issue Workflow

- Mark In Progress before starting
- Create a worktree off `origin/staging` (not local staging); run submodule + bun install
- Follow red → green → docs commit sequence
- Self-review before pushing; rebase on `origin/staging`; PR targets `staging`
- Post self-review summary as a PR comment; mark Done after PR is created

## Code Style

- No comments unless the WHY is non-obvious. Never narrate what the code does.
- No stubs ANYWHERE when implementing — never leave placeholder or canned-output code paths in production; implement fully or fail loudly, and surface the gap rather than stubbing it.
- Deterministic workflow steps (a tool/API call, fetch, export) MUST use `deterministicToolStep` from `@workbench/agents` (or an `awaitSignal` form for human input) — never an LLM agent. Only genuine-reasoning steps are agents.
- TypeScript strict mode. Load `gaas:typescript` before writing or reviewing TypeScript.
- No `console.log` — use `@intx/log` in hub/sidecar, nothing in web.
- No IIFEs or dynamic imports in production — use named async functions and static imports.
- No fallbacks for required values — `requireEnv()` for env vars, fail loudly. Fallbacks only for genuinely optional values with a single contract-guaranteed default.
- No nested ternaries — use `if`/`else` or early returns.
- All env var validation lives in `apps/hub/src/config.ts`.
- Do not modify `eslint`, `prettier`, `tsconfig`, or `package.json` unless explicitly asked.

## Types — arktype is the default (`packages/` and `apps/`)

Define new types with `type(...)` from `arktype`, deriving the TypeScript type via
`typeof Schema.infer`. This is the rule for new code in **both `packages/` and `apps/`**
(`apps/hub` and `apps/web`) — prefer it over `interface` or bare `type` aliases.

- **Parse at every trust boundary.** API responses, request bodies, anything typed
  `unknown` — validate through an arktype schema, never cast (`as T`) untrusted data.
- **Internal, already-trusted shapes** (React props, local state, values you just
  constructed) may stay plain `type`/`interface` — arktype's runtime validation buys
  nothing there. When a shape is also serialized across the API, define it once as an
  arktype schema and share it.
- When you touch a raw type that crosses a boundary, upgrade it to arktype — in a
  separate commit, after checking downstream `infer`/narrowing usage.
- `interchange/` (`@intx/*`) is out of scope — never modify upstream types.

### Canonical form — the schema is the source of truth, and is exported

A migrated base/boundary type is defined **once as an exported arktype schema**, with the
TypeScript type derived from it. The schema — not the inferred type — is the canonical
definition; export it even when no caller validates through it yet, so the runtime
validator is always in reach at the boundary. A bare, unexported `const Schema = type(...)`
that is only ever read as `typeof Schema.infer` is the wrong shape — `no-unused-vars` flags
it, and it signals a schema that was demoted to a type-only alias. Export it (or use it).

```ts
// correct — schema exported, type derived from it
export const GammaTemplateSchema = type({
  id: "string",
  gammaId: "string",
  name: "string",
});
export type GammaTemplate = typeof GammaTemplateSchema.infer;

// wrong — schema hidden behind a type-only alias (lint error, defeats the migration)
const GammaTemplateSchema = type({
  id: "string",
  gammaId: "string",
  name: "string",
});
export type GammaTemplate = typeof GammaTemplateSchema.infer;
```

- **An unused-at-runtime schema is acceptable; a plain-`type` downgrade is not.** Do not
  convert an arktype schema back to a hand-written `type {...}` to silence a lint warning —
  export the schema instead. The goal of these migrations is that every base/boundary type
  _is_ an arktype schema.
- **Non-serializable members** (injected functions like a `fetcher`, class instances) cannot
  be expressed in arktype. Keep the serializable subset as an exported schema and intersect
  the function field as a plain type: `type Config = typeof ConfigSchema.infer & { fetcher?: Fetch }`.

## Dependency Injection

Inject stateful resources (DB, HTTP clients). Import stateless singletons (config, loggers) directly.

```ts
export function createWorkflowRouter(db: DB['db']): Hono { ... }  // correct
export function createWorkflowRouter(db: DB['db'], config: Config): Hono { ... }  // wrong
```

In tests, mock at the module boundary (`mock.module(...)`) — do not inject fakes as function arguments.

## Frontend (apps/web)

Detailed rules in `apps/web/CLAUDE.md`; non-negotiables:

- **TanStack Query only** for data fetching. No `useEffect` + `fetch`.
- **Gate queries with `enabled`**; `staleTime ≥ 5 min` for catalog/static data.
- **`mutateAsync` must have `.catch()`** — never `void mutateAsync().then()`.
- **ArkType at the boundary.** Parse API responses / `unknown` through ArkType; plain types for already-trusted shapes.
- Derive component behavior from the loaded resource, not from navigation props.

## Constraints

- Do not make CRM sync (Attio) a dependency for v1
- Do not build a fully automated pipeline — keep humans in the loop
- Exports: markdown, clipboard, email draft, Slack, Typefully

## Personality

- Professional, plain language, no jargon you haven't earned
- Concise — one clear sentence beats a paragraph
- No emojis
