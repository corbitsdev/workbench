# Seed reconciliation

How workbench's automatic seeding converges on the shipped defaults
without ever fighting a member. Every seed pass — a hub boot, an
onboarding run, a `workbench seed` — must satisfy four properties:

1. **Idempotent restart** — re-running creates nothing twice.
2. **Content convergence** — a changed shipped default updates the
   seeded row to the current version.
3. **Member edits win** — a row a member touched is never overwritten,
   re-enabled, resurrected, or deleted by a later pass.
4. **Orphan handling** — a default that no longer ships is retired
   (hidden or removed), never left dangling — unless a member made the
   row theirs.

Ambiguity always resolves toward property 3: when a pass cannot prove a
row is still seed-owned, it leaves the row alone.

## Template library (hub boot)

`apps/hub/src/template-library-seed.ts` schedules
`seedTemplateLibrary` (`packages/artifacts-hub/src/template-library.ts`)
against the operator bench. Each shipped template manifest becomes one
versioned artifact row (`kind: workbench-template`, title = template
id), and the seed records the SHA-256 of the content it last wrote in
the artifact's `source.seededContentHash`.

- The marker distinguishes "the shipped manifest moved" (head content
  still equals the marker: write a new version) from "a member edited
  this" (head content diverged: keep, outcome `kept`).
- A template dropped from the manifests is archived with
  `source.retired` when still seed-owned; re-adding it unarchives and
  converges (`restored`). A member's own archive — no `retired` flag —
  stays archived.
- Rows seeded before the marker existed adopt one when their content
  still matches the shipped manifest, and are otherwise preserved.
- A member-created artifact sharing a template's title is never touched
  and never duplicated.

## Default routine presets (onboarding / `workbench seed`)

`ensureDefaultRoutines` (`packages/hub-client/src/default-routines.ts`)
plants `DEFAULT_ROUTINE_PRESETS` through `POST /routines` with a
`presetKey`, backed by `@corbits/routines`' `createRoutineIfAbsent`.

- Preset routines are born disabled server-side — no "Created routine"
  notice, no fire, no follow-up PATCH. The member enabling one is the
  announcement.
- A member-deleted preset routine leaves a soft-delete tombstone; the
  hub answers a re-create with 204 and refuses to resurrect it.
- Existing rows are matched by `presetKey` (name only for rows planted
  before the key existed), so renaming a routine does not cause a
  re-plant.
- Once planted, a routine's schedule, input, and name belong to the
  bench: a moved preset shapes only freshly-planted rows.
- A routine whose preset no longer ships is deleted only while pristine
  (`updatedAt` still equals `createdAt`); a member-touched row is kept.

## Env provider credentials (hub boot)

`apps/hub/src/env-credential-plant.ts` delegates to
`plantEnvProviderCredentials` (`packages/onboarding`): keyed by the
provider's stable credential name, a provider already carrying an
active credential is skipped outright — a rotated or hand-renamed key
is never touched. Removing an env var never deletes the planted
credential: credentials are operator data once planted, not seeds to
garbage-collect.
