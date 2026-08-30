# Contributing

Thanks for your interest in Corbits Workbench.

> **`vendor/intx` is read-only vendored code.** Never open a PR that
> changes anything under `vendor/intx` — it is hand-copied, ledgered
> `@intx/*` source, not code this repo owns. See [VENDORED.md](VENDORED.md)
> for the ledger and how to propose a change upstream instead.

## Before you start

- Contributions are accepted under the terms of the
  [Contributor License Agreement](CLA.md) and the project license: the
  application ([GPLv2 with AI Exception](LICENSE.md)), or LGPL-2.1-or-later
  for contributions to a library under `packages/` or `workflows/`.
- Read [AGENTS.md](AGENTS.md) — the ground rules there apply to human and
  agent contributors alike.

## The short version

1. `bun install` (or `bun run hooks:install`) sets a repo-local pre-push
   hook. That hook is the local stand-in for the cheap CI jobs: lint,
   typecheck, and unit tests. GitHub still runs walking-skeleton, e2e,
   isolation, and database-backed suites. Skip the hook with
   `git push --no-verify` or `SKIP_WORKBENCH_HOOKS=1`.
2. `bun run check` — everything must be green before and after your
   change.
3. Tests first: add failing tests, then the implementation, then docs.
4. One logical change per commit; write messages for a public audience.
5. Never commit secrets. `.env.example` is the only tracked env file.
6. Never vendor code without a ledger row and kill date in
   [VENDORED.md](VENDORED.md).
7. A package that owns its own product tables follows
   [docs/package-migrations.md](docs/package-migrations.md): literal SQL,
   a package-owned ledger table, applied transactionally.
8. Security issues go through [SECURITY.md](SECURITY.md), never a public
   issue.

This document will grow as the project does.
