# 3c-domain_tests_batch_b

Work in `worktrees/expand-linear-graphql-api/packages/tools-linear`.

## Objective

Add tests for: `comments.ts`, `attachments.ts`, `documents.ts`, `labels.ts`, `statuses.ts`, `search.ts`, `views.ts`, `webhooks.ts`, `analytics.ts`.

## Pattern

Stub `LinearFetch`; route on query substring; verify write tools call mutations.

## Verify

```bash
cd packages/tools-linear && bun test --isolate
```

## Commit

`linear tools: add tests for comments attachments labels webhooks and search`
