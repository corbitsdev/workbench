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

## Drafts, and the deviation behind them

A draft's *existence* is the pending state: while a draft exists the
skill is invisible to `list`, `search`, and `load`, and it carries no
`skill_access` row at all. Publishing creates the canonical asset,
commits the drafted `SKILL.md` into it, writes the access row, and only
then drops the draft — so a failure mid-publish leaves a retryable draft
rather than a half-published skill.

A draft is **not** its own asset kind. The hub's asset kinds are a closed
set (`agent-state`, `skill`, `package-registry`, `workflow`) defined in
vendored platform code this repo never edits, so there is no
`skill-draft` kind to create. A draft is instead a real `kind:"skill"`
asset whose asset name carries the `draft-` prefix. That prefix is
therefore reserved: a skill may not be named into it.

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
