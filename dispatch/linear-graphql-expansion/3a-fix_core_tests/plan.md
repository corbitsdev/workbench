# 3a-fix_core_tests

Work in `worktrees/expand-linear-graphql-api/packages/tools-linear`.

## Objective

Make `src/index.test.ts` pass against modular handlers (`issues.ts`, `teams.ts`, `users.ts`, `hub-tools.ts`).

## Tasks

1. Update assertions for arktype validation messages (`linear_create_issue: teamId must be a string`).
2. Fix `listIssues` tests for expanded filters/cursor/pagination in `issues.ts` (read handler + GraphQL variables).
3. Fix `getIssue` tests for optional `includeRelations` if present.
4. Fix create issue stub routing so mutation failure test hits GraphQL stub not real network.
5. Fix TS18048 in tests: use non-null assertion or `expect(LINEAR_HUB_TOOLS.linear_list_issues).toBeDefined()`.
6. Extend `LINEAR_HUB_TOOLS` test to assert all write tools classified `write`.

## Verify

```bash
cd packages/tools-linear && bun test --isolate && bun run typecheck
```

## Commit

`linear tools: fix core handler tests after hub modularization`
