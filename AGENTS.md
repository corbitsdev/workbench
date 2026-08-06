# Workbench — Agent Guide

Corbits Workbench is the multiplayer workspace for humans and agents — teams
and AI agents working side by side in shared [benches](docs/GLOSSARY.md),
with the same threads, workflows, and inbox. It is the default
implementation of the Corbits Platform: a set of pluggable libraries, with
[Interchange](https://github.com/faremeter/interchange) at the core,
offering agents, workflows, and multi-tenant capabilities. Everything
composes as a library another build could plug in — hardcoded,
build-specific machinery is a defect — and every external side effect sits
behind human approval.

## Ground rules

- **Interchange is the platform.** Credential resolution, agent launch,
  session orchestration, LLM inference, ID generation, and the workflow
  runtime belong to `@intx/*` — never reimplement them. Consume `@intx/*` as
  published npm packages wherever a publish covers the needed capability; no
  git submodules, no custom resolve conditions. If a needed capability is
  unpublished, vendor it with attribution and say so in the PR — never fork
  silently. Every vendored path gets a ledger row with a kill date in
  [VENDORED.md](VENDORED.md), the authoritative ledger of any active vendored
  paths; hand-copied files only, never a submodule, and the upstream
  repository is never touched.
- **Apps stay generic; packages own the domain.** A product rule inside
  `apps/*` belongs in a package.
- **Where each kind of thing lives.** Deployable services in `apps/`, domain
  packages and root-bucket modules in `packages/`, workflow definitions in
  `workflows/`. Root-bucket modules are operator-installed and may declare
  routes, migrations, credentials, and grants; sandboxed installables use
  Interchange's native contracts and never get root-bucket powers.
- **No fallbacks, no spread-assembly.** Cut over cleanly — never leave a
  legacy path beside a new one. Build config and manifest objects as explicit
  literals, never assembled by spreading.
- **Self-documenting code over comments.** Name things so the code explains
  itself; a comment is for the rare "why" the code cannot express, never a
  restatement of what it does.
- **Parse at every trust boundary.** arktype schemas for env, request bodies,
  and external data; never `as T` untrusted input.
- **Core UI components live in
  [corbitsdev/react-ui](https://github.com/corbitsdev/react-ui).** Build
  reusable components there and consume them here; only workbench-specific
  composition lives in this repo.
- **This repo is public.** No secrets or credentials, ever — `.env.example`
  is the only tracked env file. Anything sensitive or on-the-fence (client
  names, internal context) goes in Linear, not in commits, PRs, or docs.

## Working conventions

- `bun run check` (typecheck, lint, test) must pass before every commit.
- Commit sequence per change: tests first ("Add tests for X"), then
  implementation ("X: what changed"), then docs ("Update docs: X"). One
  logical change per commit; commit messages are written for a public
  audience.
- Worktrees live in `.worktrees/<branch>`; branch = `cl-<issue#>-<slug>`.
- Tests are meaningful red/green tests only — no coverage theater. Merged
  line coverage floor: 80%.
- Deployment is explicit via Pulumi (Railway); CI runs tests only — nothing
  auto-deploys on main.

## Docs map

- [README.md](README.md) — quickstart and repo layout
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution flow and CLA
- [LICENSE.md](LICENSE.md) — GPLv2 with AI Exception
- [SECURITY.md](SECURITY.md) — how to report vulnerabilities
- [VENDORED.md](VENDORED.md) — the vendoring ledger and its rules
- `docs/` — architecture and design docs, added as the system grows
