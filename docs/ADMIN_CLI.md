# Admin CLI

The admin CLI (`apps/hub/bin/admin/`) is the single operator entrypoint for
running hub operations against an environment — tenancy, credentials, tools, and
workflows. It replaces the former one-off npm scripts and bin tools.

## Entrypoints

Three env-scoped entrypoints, defined as scripts in `apps/hub/package.json`:

- `bun run admin` — loads `../../.env`
- `bun run admin:staging` — loads `../../.env.staging`
- `bun run admin:production` — loads `../../.env.production`

Tenancy cutover inventory (read-only; uses the same env files):

- `bun run audit-tenancy:staging` — `../../.env.staging`
- `bun run audit-tenancy:production` — `../../.env.production`
- `bun run audit-tenancy` — `../../.env`

Optional `TARGET_ROOT_SLUG` (default: `GLOBAL_TENANT_SLUG`). Set `DATABASE_URL` in
the env file for the full tenant table and workbench row counts; HTTP lists require
`SUPERADMIN_*` or a valid `SESSION_TOKEN`. If hub auth fails but `DATABASE_URL` is
set, `audit-tenancy` falls back to DB-only inventory and prints a cutover strategy.

Hub deploy env (not admin CLI): `AUTO_JOIN_TENANT_SLUGS` — comma-separated tenant
slugs to auto-join on signup/login. Default empty (CL-2855). Set to `abklabs` on
deploy to preserve legacy “everyone joins the org root” until invites land.

Hub boot can also auto-sync embedded tool tarballs into the root
`package-registry` asset when `TOOL_REGISTRY_AUTOPUBLISH_ON_BOOT=true` (CL-3093);
see [DEPLOYING_WORKFLOWS.md](./DEPLOYING_WORKFLOWS.md). Manual **Publish tool
packages** in Local actions remains valid for ad-hoc publishes.

## Flow

1. **Auth** — sign in via `signIn` using `SUPERADMIN_EMAIL` / `SUPERADMIN_PASS`,
   or an existing `SESSION_TOKEN`.
2. **Select tenant** — list the principals from `GET /api/me/principals` (a user
   may be a principal of many tenants) and pick one.
3. **Select resource** — pick from the resources discovered dynamically from the
   hub's live `GET /openapi.json` (no hard-coded endpoint list).
4. **Select action** — pick an action on that resource.
5. **Enter inputs** — the CLI prompts for required inputs.
6. **Execute** — the request runs against the selected environment.

The selected tenant auto-fills the `tenant` (slug) and `tenantId` query/path
parameters, so they never have to be typed by hand. Resources and actions come
from the OpenAPI spec: all custom hub routes are annotated with `describeRoute`
(hono-openapi), so they appear alongside Interchange's already-annotated routes.

The CLI is built on the vendored `@workbench/openapi-arktype`
(`packages/openapi-arktype/`), which generates arktype validators from the spec;
the CLI uses its `createClient({ url })` runtime to drive discovered resources.

## Local actions

Non-HTTP operator tasks appear as their own top-level resources, alongside the
spec-driven ones. The selected tenant is threaded into each internally, so it is
never typed by hand:

- **Local actions (build, seed)** — Seed superadmin (bootstrap), Seed tool
  credentials from env, **Seed model catalog (providers, models, offerings)**,
  Add LLM credential, **Backfill supervisor session IDs (analytics)** (see
  [ANALYTICS.md](./ANALYTICS.md)), Build tool packages, Publish tool packages.
- **Workflows** — **Push (deploy) a workflow**: the CLI discovers the available
  workflow kinds from `workflows/*` and presents them as a list to pick from, so
  operators never have to know a kind by heart. The push authenticates with the
  operator's `SESSION_TOKEN` against the session-gated deploy route (authorized
  by the native grant check); see [DEPLOYING_WORKFLOWS.md](./DEPLOYING_WORKFLOWS.md).

Each action spawns the corresponding hub bin script internally; operators never
invoke those scripts directly.

## Inference setup and migration (model catalog)

Agent launch resolves inference sources from each agent's `modelRequirements`
against the tenant **model catalog** (`model` / `model_provider` /
`model_offering`), not from `credentialRequirements`. New environments must seed
the catalog or every agent launch fails with `no_requirements` (no Myra/Oat;
artifacts appear broken).

> **v1 tenancy — seed at the GLOBAL tenant.** Myra and every other agent
> currently run as instances in the **global org tenant** (agent templates are
> seeded there at hub boot; see [ARCHITECTURE.md](./ARCHITECTURE.md) §Tenancy).
> Their inference resolves against that tenant's catalog, so the **model catalog
> and the LLM credentials must be seeded on the global tenant** — descendant
> workbenches inherit both via the nearest-ancestor walk. Seeding them only on a
> sub-tenant (e.g. a single workbench) is **not** enough and leaves Myra showing
> "No API credential is set up." This global-tenant placement is a deliberate v1
> mechanism and is expected to change when agents move to per-workbench tenancy.

Order on a fresh environment (run against the **global** tenant so descendant
workbenches inherit via the catalog ancestor walk):

1. **Seed tool credentials from env** — creates the LLM credentials
   (`opencode-zen`, `anthropic-api`, …) the catalog providers authenticate with.
2. **Seed model catalog** — derived from `FULL_CATALOG` in `@workbench/catalog`:
   one `model_provider` per inference credential (baseURL read from the
   credential's metadata), one `model` per canonical name, and an offering
   linking them. Idempotent — re-runs skip existing rows. A provider whose
   credential is **not** present in the tenant (and its offerings) is skipped
   with a warning rather than failing the whole seed, so a tenant carrying only
   `opencode-zen` + `anthropic-api` seeds cleanly — seed step 1 first for every
   provider you actually want offerings for. To change a provider's baseURL or
   credential binding, delete the catalog provider and re-seed; the seeder does
   not reconcile an existing row in place.
3. **Redeploy the hub** — `seedAgentTemplates` writes each agent's
   `modelRequirements` onto its row on boot (insert and update), so existing
   agents migrate in place; no backfill script.

**Migrating a running agent to a changed model:** edit its definition's
`modelConfig.defaultModel` in `@workbench/agents`, ensure the catalog carries
that model (re-run **Seed model catalog**), redeploy the hub (updates the agent
row's `modelRequirements`), then spin the instance down and up — the relaunch
re-resolves sources from the catalog. The launch guard short-circuits cleanly if
the catalog cannot resolve an agent's model, so a missing offering surfaces as a
non-launch rather than a crash.

### Bifrost as the primary gateway (offering priority + failover)

Source resolution (`@intx/db resolveModelSources`) returns an **ordered**
`InferenceSource[]` for a model — head = the default source, tail = the automatic
failover chain — ordered by each offering's `priority` **ascending** (lower wins
the head), tie-broken by offering id. The runtime reactor fails over head → tail
on credential / protocol-mismatch / retryable / timeout errors and resets to the
head each new call, so a transient blip on the head provider fails over for that
call and the next call tries the head again. Every `CATALOG_OFFERINGS` row in
`@workbench/catalog` carries an explicit `priority`; `seed-catalog` sends it to
the offering-create route (an absent value defaults to 0).

**Bifrost is the primary proxy**, with the direct providers kept as the fallback
tail. The catalog declares one Bifrost provider per wire format — all on the same
Bifrost instance sharing **one virtual key** (`BIFROST_API_KEY`), owner-prefixed
so a customer workbench can shadow with its own `<customer>-bifrost*` rows:

| Provider                            | plugin            | Bifrost surface (baseURL suffix) | env for baseURL              |
| ----------------------------------- | ----------------- | -------------------------------- | ---------------------------- |
| `corbits-default-bifrost`           | openai-compatible | `/v1`                            | `BIFROST_BASE_URL`           |
| `corbits-default-bifrost-anthropic` | anthropic         | `/anthropic`                     | `BIFROST_ANTHROPIC_BASE_URL` |
| `corbits-default-bifrost-genai`     | google-genai      | `/genai`                         | `BIFROST_GENAI_BASE_URL`     |

The base URL is the gateway host plus the per-surface suffix — e.g.
`https://corbits-ai-gateway.up.railway.app/v1`. The openai-compatible adapter
treats the base as ending in `/v1` and appends `/chat/completions`; the anthropic
(`/anthropic`) and google-genai (`/genai`) adapters append their own version
path, so those bases carry no `/v1`. There is no default base URL — it is a
self-hosted gateway, so each surface seeds only when its base URL env is set (or
is entered from the Owner Catalog page). **Each model gets exactly one Bifrost
head at priority 1** — `bifrost /v1` where the model has an openai-compatible
offering (its current head wire format), or the matching native surface
(`/anthropic`, `/genai`) where the model is native-only. The fallback tail is the
openai-compatible directs (`opencode-zen`/`near-ai`) at priority 2, then the
native directs (`anthropic-api`/`OpenAI`/`google-ai`) at priority 3. So Bifrost
is the head and the prior provider(s) are the failover tail — priority ordering
only, never a `pin` (which would drop the fallback).

Each surface is gated independently — `seed-credentials` seeds a surface only
when its own base URL env is set (`/v1` on `BIFROST_BASE_URL`, `/anthropic` on
`BIFROST_ANTHROPIC_BASE_URL`, `/genai` on `BIFROST_GENAI_BASE_URL`), all sharing
the one VK. **Offerings reconcile priority on re-seed**: an existing offering's
priority is PATCHed in place, so re-running **Seed model catalog** after a
priority change reorders the head/tail without a destructive delete (a changed
provider **baseURL** still lives on the provider row and needs delete + re-seed).
After a re-seed, relaunch agents — the source list is baked at launch. The change
is inert until a Bifrost credential is seeded: with `BIFROST_API_KEY` (or a
surface's base URL) unset, `seed-catalog` skips that Bifrost provider and its
offerings and every agent resolves against `opencode-zen` exactly as before.
