# Admin CLI

The admin CLI (`apps/hub/bin/admin/`) is the single operator entrypoint for
running hub operations against an environment — tenancy, credentials, tools, and
workflows. It replaces the former one-off npm scripts and bin tools.

## Entrypoints

Three env-scoped entrypoints, defined as scripts in `apps/hub/package.json`:

- `bun run admin` — loads `../../.env`
- `bun run admin:staging` — loads `../../.env.staging`
- `bun run admin:production` — loads `../../.env.production`

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
  Add LLM credential, Build tool packages, Publish tool packages.
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

Order on a fresh environment (run against the **global** tenant so descendant
workbenches inherit via the catalog ancestor walk):

1. **Seed tool credentials from env** — creates the LLM credentials
   (`opencode-zen`, `anthropic-api`, …) the catalog providers authenticate with.
2. **Seed model catalog** — derived from the agent definitions themselves
   (`AGENT_CATALOG` in `@workbench/agents`): one `model_provider` per inference
   credential (baseURL read from the credential's metadata), one `model` per
   canonical name an agent declares, and an offering linking them. Idempotent —
   re-runs skip existing rows. To change a provider's baseURL or credential
   binding, delete the catalog provider and re-seed; the seeder does not
   reconcile an existing row in place.
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
