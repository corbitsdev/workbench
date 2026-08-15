# @corbits/skills

The workbench's skill registry, over the platform's own native
`kind:"skill"` assets. A skill is a named, reusable capability —
instructions an agent can pin and a workbench can install.

## Where a skill actually lives

One skill is one `kind:"skill"` hub asset carrying a single
`<name>/SKILL.md`. That is the platform's own asset kind, validated by
the hub's native skill kind handler on every push: the frontmatter must
carry a kebab-case `name` matching the directory and a 1–1024-character
`description` free of HTML tags.

Nothing about a skill is duplicated into a table. In particular:

- **Version history is the asset's git history.** `versions` reads the
  commit log off the asset repo; `restore` re-commits an older commit's
  `SKILL.md` onto the default ref, so a rewind is a new commit and the
  history is never rewritten. There is no versions table.
- **The body is the committed blob.** `load` reads it back from the
  asset, never from a cache.

The one table this package owns is `skills.skill_access` — the
visibility verdict, and nothing else. See `src/migrations.ts` and
[docs/package-migrations.md](../../docs/package-migrations.md).

A skill is created directly: `create` writes the `kind:"skill"` asset,
commits its `SKILL.md`, and writes the `skill_access` row — no pending or
draft state in between. A validation failure (a name or description the
schema rejects) fails before any asset is created, so it leaves nothing
behind. A failure between those three writes is not atomic, though:
`create` isn't a transaction across the asset store and the access
table, so a crash or timeout partway through can leave the asset written
but not yet committed or accessible. That's not silent data loss —
retrying the same create on the same name detects the caller's own
half-written asset and finishes it (writing the missing `SKILL.md`
commit and/or access row) instead of 409ing forever. A fully-formed
skill, or another caller's half-written asset, still 409s as a genuine
name conflict.

## Two surfaces

- `createSkillRoutes` — tenant-session routes under
  `/api/tenants/:tenantId/skills`, what the Skills settings section
  calls. Caller identity comes from the session context, never a body.
- `createWorkflowSkillRoutes` — run-authenticated routes under
  `/api/workflow-skills`, what a workflow child's
  `@corbits/tools-skills` bundle calls with the sidecar's own bearer
  token and the run's own address. Mounted outside the tenant prefix,
  mirroring `@corbits/memory-hub`.

Both scope every read to the calling principal: a `private` skill is
visible only to its author, a `tenant` one to every principal in its
tenant, and nothing is ever visible across tenants.

## The pinned-skills prompt index

`withAvailableSkills` appends an `<available_skills>` stanza to a
definition's system prompt — names and descriptions only, plus the
instruction to call `load_skill` for a body. Re-pinning replaces the
stanza rather than stacking one, and unpinning everything removes it.
Bodies are never inlined: most turns need none of them, and the ones a
turn does need are fetched on demand.
