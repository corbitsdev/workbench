# @corbits/skills

The workbench's skill registry, over the platform's own native
`kind:"skill"` hub assets. A skill is a named, reusable capability — a
`SKILL.md` an agent can pin and a workbench can install, create, version,
and scope access to per-principal.

## Composition with @intx/*

A skill's storage, version history, body, and visibility are entirely
the platform's own asset/git machinery — this package owns no tables
and ships no migrations, only reading and committing through the asset
store. Routes are built on `@intx/hub-api`'s `TenantEnv`/`requireGrant`
convention, with `@intx/hub-sessions` for session-authenticated calls.

## Key modules

- `src/registry.ts` — `SkillRegistry`: create/list/get/versions/restore
  over the `kind:"skill"` asset, with no intermediate pending/draft state.
- `src/skill-md.ts` — the SKILL.md grammar: builds, parses, and validates
  the `name`/`description`/`scope` frontmatter and the markdown body. This
  is the only place visibility is decided — there is no side table.
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

## Running tests

```
cd packages/skills && bun test
```

No drizzle suite in this package's `test/` directory and no migrations
to apply; no `DATABASE_URL` needed for `bun test` here.
