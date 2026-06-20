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

A "Local actions" group covers non-HTTP operator tasks. The selected tenant is
threaded into each internally, so it is never typed by hand:

- **Seed superadmin** — bootstrap
- **Seed tool credentials from env**
- **Add LLM credential**
- **Build tool packages**
- **Publish tool packages**
- **Push a workflow** — prompts for the workflow kind ("Workflow kind (e.g.
  pain-point-collateral)"); type just the kind value (e.g.
  `pain-point-collateral`) and the CLI handles the rest.

Each action spawns the corresponding hub bin script internally; operators never
invoke those scripts directly.
