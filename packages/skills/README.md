# @corbits/skills

The workbench's skill registry, over the platform's own native
`kind:"skill"` hub assets. A skill is a named, reusable capability — a
`SKILL.md` an agent can pin and a workbench can install, create, version,
and scope access to per-principal.

## Composition with @intx/*

A skill's storage, version history, and body are entirely the platform's
own asset/git machinery — this package writes no versions table and no
content cache, only reading and committing through the asset store. Routes
are built on `@intx/hub-api`'s `TenantEnv`/`requireGrant` convention, with
`@intx/hub-sessions` for session-authenticated calls; persistence for the
one table this package does own goes through `@intx/db`.

## Key modules

- `src/registry.ts` — `SkillRegistry`: create/list/get/versions/restore
  over the `kind:"skill"` asset, with no intermediate pending/draft state.
- `src/access.ts` / `src/access-store.ts` — the `skill_access` table and
  visibility rules (`private` to the author, `tenant`-wide, or scoped),
  the one thing this package persists beyond the asset itself.
- `src/skill-md.ts` — `SKILL.md` frontmatter parsing/building and the
  `name`/`description` validation schemas.
- `src/hub-asset-store.ts` — the production `SkillAssetStore` binding
  against the platform's native asset kind handler.
- `src/routes.ts` — `createSkillRoutes`: tenant-session routes under
  `/api/tenants/:tenantId/skills` for the Skills settings surface.
- `src/workflow-routes.ts` — `createWorkflowSkillRoutes`: run-authenticated
  routes under `/api/workflow-skills` for a workflow child's
  `@corbits/tools-skills` bundle.
- `src/prompt.ts` — `withAvailableSkills`: appends/replaces the
  `<available_skills>` system-prompt stanza for a definition's pinned
  skills.
- `src/migrations.ts` — this package's own `skills_migrations` ledger,
  covering only the `skill_access` table.

## Running tests

```
cd packages/skills && bun test
```

No drizzle suite in this package's `test/` directory; no `DATABASE_URL`
needed for `bun test` here (`src/migrations.ts` applies against a real
Postgres only when a host runs it).
