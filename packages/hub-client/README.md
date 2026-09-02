# @workbench/hub-client

The hub's native HTTP API as a typed client, plus tenant seeding:
authenticate, deploy the default workflow set, seed the dev model catalog,
and confirm every deployment actually answers before reporting success.
Both the CLI's own `seed` verb and the first-login provisioning hook
consume this package so the seeding logic exists in one place.

## Composing with `@intx/*`

This package wraps Interchange's hub HTTP API rather than reimplementing
it — `createHubAPI` is a thin `fetch` boundary against the hub's own
routes, and `@intx/inference`/`@intx/types` supply the model-source and
response types it validates responses against with `arktype`. Workflow
definitions come from this repo's own `@corbits/*-workflow` packages
(`assistant-workflow`, `workbench-digest-workflow`, `echo-workflow`,
`heartbeat-workflow`, `recurring-task-workflow`), and tool-package
publishing is delegated to `@corbits/tool-registry-publish` rather than
duplicated here.

## Key modules

- **`src/hub.ts`** — `createHubAPI`: the `ApiCall` fetch boundary
  (JSON in, JSON out, cookie jar for better-auth sessions), plus
  `authenticate` and `parseAs` response validation.
- **`src/seed.ts`** — `seedTenant`/`seedCatalog`: pushes and deploys
  `DEFAULT_WORKFLOWS`, ensures credentials/providers, and confirms every
  deployment answers. Safe to re-run — every skipped step says so.
- **`src/workflow-push.ts`** — `createGitWorkflowPusher`: pushes a
  workflow definition to its asset repo over the hub's smart-HTTP git
  route using the system `git` binary, rendering the source tree via
  `@corbits/workflows`'s `renderWorkflowSourceTree`; content-aware, so an
  identical tree is a reported skip, not a duplicate commit.
- **`src/credential-test.ts`** — a real, free test call for a credential
  before it's stored, one per `SupportedCredentialProvider`; exported from
  the `./credential-test` subpath so a browser bundle (the onboarding
  wizard) never pulls in the seed workflows or `@intx/inference`.
- **`src/catalog-seed-data.ts`** — `CATALOG_SEEDS`: the curated
  per-provider dev model catalog `seedCatalog` plants.
- **`src/errors.ts`** — `CliError`: an operator-actionable error carrying
  both the problem and its fix, used throughout this package's failures.

## Running tests

```sh
cd packages/hub-client && bun test
```

Tests run against a mocked `ApiCall`/`fetch` (see `test/helpers.ts`); no
`DATABASE_URL` or live hub is required.
