# @workbench/openapi-arktype

Generate [ArkType](https://arktype.io) validators from OpenAPI 3.x specifications.
Used by the hub admin CLI to consume the hub's live `/openapi.json` for runtime
operation discovery and request/response validation.

## Vendored — credit

This package is **not original work.** Its `src/` is vendored verbatim from
[**alexanderguy/openapi-arktype**](https://github.com/alexanderguy/openapi-arktype),
authored by **Alexander Guy** and licensed MIT (see `LICENSE`, which retains his
copyright). It is pinned at commit `8cd4b6d1a6f7de30d5ab40d432a072f1d897c776`.

We carry the source only because the package is not yet published to npm. Keep
`src/` as close to upstream as possible; if upstream publishes a release, prefer
switching to the published package over diverging this copy. All credit for the
implementation belongs to the upstream author.

The package keeps its own `tsconfig.json` (without `exactOptionalPropertyTypes`,
`verbatimModuleSyntax`, or `noUncheckedIndexedAccess`) so the upstream source
typechecks unmodified. Consumers still get fully-typed exports.

## Runtime usage

```ts
import { createClient } from '@workbench/openapi-arktype';

const client = await createClient({ url: 'https://hub.example.com/openapi.json' });

// Discover operations
const op = client.operation('post', '/api/v1/workflows/deploy');
// Validate a request body / response against the spec's arktype validators
const result = op?.requestBody?.['application/json']({ kind: '...' });
```
