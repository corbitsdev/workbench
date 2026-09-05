# Seed reconciliation

How workbench's automatic seeding converges on the shipped defaults
without ever fighting a member. Every seed pass — a hub boot, an
onboarding run, boot-time seeding — must satisfy four properties:

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

## Template library (first library read)

`createTemplateLibrarySeeder`
(`packages/artifacts-hub/src/template-library.ts`) runs
`seedTemplateLibrary` for the tenant whose shelf is being read, on the
`GET /api/tenants/:id/library/templates` routes themselves. Each shipped
template manifest becomes one versioned artifact row (`kind:
workbench-template`, title = template id), and the seed records the
SHA-256 of the content it last wrote in the artifact's
`source.seededContentHash`.

The trigger is the read, not a boot window, because template rows are
tenant-scoped: every bench owns its own shelf, so a bench created long
after the hub booted converges the first time its picker opens, in any
boot order. One pass per tenant per process, shared by concurrent first
reads; a failed pass is not remembered, so the next read retries rather
than the shelf staying empty until a restart. A read whose pass failed
answers 503 — never a 404, which would read as "no such template".

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

## Default scheduled workflows (onboarding / boot-time seeding)

Seed never POSTs `/routines`. Native `ScheduleTrigger` ticks digest;
last-30-days-research stays a deployed workflow, not a wrapper row.
`scripts/db-setup.ts` drops a leftover `routines` schema after the
digest enablement handoff. There is no preset-wrapper prune: seed does
not plant wrapper rows.

## Default vs. on-demand catalog workflows (CL-7074)

`DEFAULT_WORKFLOWS` (`packages/seeding/src/seed.ts`) is the set every
real signup gets automatically: `assistant` (Myra), and nothing else. A
fresh bench used to also pay a git push and a sidecar probe for `echo`,
`workbench-digest`, and `last-30-days-research` — three workflows
nobody had asked for yet. Those three now live in `CATALOG_WORKFLOWS`,
same shape (`DefinitionWithAgentSteps`-backed `DefaultWorkflow`
entries), deployed the same way (`ensureWorkflowAsset` → `pushWorkflow`
→ `ensureDeployment`), but only when something asks for one by name —
the catalog/instantiate surface, or a test standing up its own fixture
bench — never automatically at signup.

There is no orphan-retire for an entry that moved from
`DEFAULT_WORKFLOWS` to `CATALOG_WORKFLOWS`: an asset already deployed
on an existing bench from before the move is left exactly as it is.
`CATALOG_TEST_WORKFLOWS` remains the separate, never-reaches-a-real-
signup set for workflows that exist only to exercise the platform
continuously.

## Default skills (boot-time seeding)

`plantDefaultSkills` (`packages/seeding/src/seed.ts`) plants each
`DEFAULT_SKILLS` entry through `POST /api/tenants/:id/skills`, after
first checking `GET /api/tenants/:id/skills/:name`.

- An existing row the by-name GET finds is skipped outright.
- A `409` from the create call itself — a row the GET missed (an
  inherited/other-scope row, or a race with a concurrent seed pass) —
  is also a skip, never a fatal error. Every seed step treats
  "already exists" as done, not as a reason to abort the run the
  hub's own error advice told the operator to re-run.

## Tool registry publish (boot-time seeding, onto the root tenant)

`publishCorbitsToolsRegistry` (`packages/tool-registry-publish/src/publish.ts`)
finds-or-creates the tenant's `corbits-tools` package-registry asset,
then PUTs whatever tarball is missing. Boot-time seeding
(`apps/hub/src/system-seed.ts`) calls this onto the root tenant so
descendants inherit tarballs; the rest of seeding does not pack. Two
properties keep a failed publish from stranding a
usable-looking-but-empty asset:

- `checkToolPackageFreshness` runs **before** the asset is ever
  created — a version-bump violation aborts the publish with no HTTP
  call made and no asset row planted, so this exact failure can never
  leave a dangling registry asset behind on a fresh tenant again.
- Listing tarballs on an asset whose repo has no commits yet (a
  never-published asset, or one whose row survived from before the
  point above shipped) answers an empty list rather than throwing —
  so a re-run of `publishCorbitsToolsRegistry` treats it exactly like
  a brand-new registry and pushes every package, which is what
  actually creates the repo's first commit. Repairing a tenant with
  this history is the same operation as publishing the registry for
  the first time: restart the hub.

## Workflow deployments (boot-time seeding)

`ensureDeployment` (`packages/seeding/src/seed.ts`) treats a
workflow's `workflow_run` deployment row as seed-owned state, but the
row's `status` column is not the whole story: the hub only routes mail
to a deployment through an in-memory table (`sidecarRouter`'s
`addressIndex`, `vendor/intx/hub-sessions/src/ws/sidecar-handler.ts`)
that binds an agent address to whichever sidecar socket most recently
proved ownership of it. That table lives in the hub process, not the
database — a hub or sidecar restart empties it, while the persisted row
still reads `deployed`.

Before skipping a `deployed`/`pending` row as "already deployed",
`ensureDeployment` checks `GET
/api/tenants/:tenantId/workflows/runs/:runId/health` (a live read of
`sidecarRouter.getRoutableAddresses()`, not the stored status) and
skips only when `liveness` answers `"ok"`. A row whose sidecar is gone
is stale, not deployed: seed logs it as stale and pushes a fresh
deployment, which mints a new `workflow_run` (new anchor run id, new
agent address) on whichever sidecar is currently connected. The stale
row is left in place rather than rebound — a sidecar carries no durable
state of its own, so handing an old run's identity to a new sidecar
process would silently pretend session state survived that never did.
A genuine redeploy is the only honest repair.

## Env provider credentials (hub boot)

`apps/hub/src/env-credential-plant.ts` delegates to
`plantEnvProviderCredentials` (`packages/onboarding`): keyed by the
provider's stable credential name, a provider already carrying an
active credential is not probed and its key is not overwritten — a
rotated or hand-renamed key is never touched. `seedCatalog` still
runs against that existing credential (`existingCredentialId`, no
`apiKey`) so a hub restart backfills newly curated models additively:
missing rows are planted, existing ones 409-skip, nothing is deleted.
Removing an env var never deletes the planted credential: credentials
are operator data once planted, not seeds to garbage-collect.
