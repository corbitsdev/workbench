# Contributing

Thanks for your interest in Corbits Workbench.

## Before you start

- Contributions are accepted under the terms of the
  [Contributor License Agreement](CLA.md) and the project license
  ([GPLv2 with AI Exception](LICENSE.md)).
- Read [AGENTS.md](AGENTS.md) — the ground rules there apply to human and
  agent contributors alike.

## The short version

1. `bun install && bun run check` — everything must be green before and after
   your change.
2. Tests first: add failing tests, then the implementation, then docs.
3. One logical change per commit; write messages for a public audience.
4. Never commit secrets. `.env.example` is the only tracked env file.
5. Never vendor code without a ledger row and kill date in
   [VENDORED.md](VENDORED.md).
6. Security issues go through [SECURITY.md](SECURITY.md), never a public
   issue.

This document will grow as the project does.
