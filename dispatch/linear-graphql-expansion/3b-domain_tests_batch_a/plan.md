# 3b-domain_tests_batch_a

Work in `worktrees/expand-linear-graphql-api/packages/tools-linear`.

## Objective

Add co-located tests for: `projects.ts`, `milestones.ts`, `initiatives.ts`, `cycles.ts`, `releases.ts`, `teams.ts`, `users.ts`.

## Pattern

Copy `makeFetchStub` / `createToolRunner` patterns from `index.test.ts`. One `describe` per tool; assert GraphQL query shape and variables.

## Verify

```bash
cd packages/tools-linear && bun test --isolate
```

## Commit

`linear tools: add tests for projects initiatives cycles releases teams users`
