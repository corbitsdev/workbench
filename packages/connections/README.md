# @workbench/connections

The Connections settings surface: shared PKCE/state primitives for OAuth
connect flows, the connector registry (inference providers plus
tool-credential connectors), and the route factories that test, store, and
resolve a connector's credential across a tenant chain.

## How it composes with Interchange

- Credentials are stored and read through `@workbench/hub-client`'s
  `ensureProvider`/`ensureCredential` helpers over the native hub API —
  this package never reimplements credential storage.
- `plugins.ts`'s tenant-inheritance resolution calls the native, already
  chain-aware `GET /credentials/resolve/:name` route
  (`vendor/intx/hub-api/src/routes/credentials.ts`, backed by
  `resolveCredentialByName` in `vendor/intx/db`) so a channel or
  sub-workbench inherits whatever an ancestor tenant connected.
- `pkce.ts`'s state store seals `{ userId, codeVerifier, nonce, expiresAt }`
  through the caller's `CredentialCipher` (`@intx/types`), the same
  AEAD seam every at-rest secret in the hub uses.

## Key modules

- `registry.ts` — the browser-safe `ConnectorDescriptor` map for every
  api-key and OAuth connector (inference providers plus Granola, Exa,
  ScrapeCreators, Linear, GitHub); imported directly by `settings-ui`
  without pulling in `hono` or `@intx/inference`.
- `descriptor.ts` — the `ConnectorDescriptor`/`ConnectorOAuthConfig` shape
  every registry entry implements.
- `routes.ts` — tenant-scoped `POST /:connectorId/credential/test` and
  `/complete`: proves an api-key connector's credential before storing it,
  mounted inside the platform's native tenant middleware.
- `oauth-routes.ts` — the generalized `GET /:connectorId/start` /
  `/callback` factory driving every `oauth-pkce`/`oauth-code` connector
  (OpenRouter, Hugging Face) from one `ConnectorDescriptor.oauth` config.
- `pkce.ts` — RFC 7636 PKCE mechanics and the restart-proof, encrypted
  single-use state store shared by every connect flow.
- `plugins.ts` — the Plugins gallery's tenant-inheritance-aware credential
  resolver (`resolveOne`, `listPluginsForTenant`).
- `provider-health.ts` — an in-memory, process-lifetime signal that a
  provider's connection needs attention, fed by connect-time test
  failures and classified runtime inference failures.
- `probes.ts` — free, real credential probes for Granola, Exa,
  ScrapeCreators, Linear, and GitHub, each hitting the same production
  endpoint its tool client calls.

## Running tests

```
cd packages/connections && bun test
```

No live database or external credentials required — every test mocks
`fetch` and injects its own store/cipher.
