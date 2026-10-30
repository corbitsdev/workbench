# Contributing

Thanks for your interest in Corbits Workbench.

> **`vendor/intx` is vendored code.** Do not open a PR that changes anything
> under `vendor/intx` unless it adds a ledgered upstream delta with a kill date.
> See [VENDORED.md](VENDORED.md) for the ledger and propose changes upstream at
> [faremeter/interchange](https://github.com/faremeter/interchange).

## Before you start

- Contributions are accepted under the terms of the
  [Contributor License Agreement](CLA.md) and the project license: the
  application ([GPLv2 with AI Exception](LICENSE.md)), or LGPL-2.1 for
  contributions to a library under `packages/`.
- [docs/local-dev.md](docs/local-dev.md) covers running the stack locally.
- [AGENTS.md](AGENTS.md), and the `AGENTS.md` files under `apps/`, hold the
  architecture and code rules every change follows, whether a person or a
  coding agent writes it.

## The short version

1. `bun run check` (typecheck, lint, format check, unit tests) must be green
   before and after your change.
2. Pull request titles and every commit subject must follow Conventional
   Commits (`feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`, `ci`,
   `build`, `style`, `revert`).
3. Tests first: `test(scope): add tests for X`, then the implementation
   (`feat(scope): ...` or `fix(scope): ...`), then docs (`docs(scope): ...`).
   One logical change per commit; write messages for a public audience.
4. Never commit secrets. `.env.example` is the only tracked env file.
5. Never vendor code without a ledger row and kill date in
   [VENDORED.md](VENDORED.md).
6. Each package that owns product tables ships one idempotent SQL migration,
   applied by the hub at boot.
7. Security issues go through [SECURITY.md](SECURITY.md), never a public issue.
8. A pull request without a linked issue is closed.
