# Credential wiring: from connect to tool call (CL-6032)

How a tenant's connected credential (Settings · Connections) reaches the
tool call a workflow step makes, and the `CredentialProvider` plugins
that shape it.

## The chain

1. A tool package (e.g. `@corbits/granola-tools`) declares a credential
   handle in its `package.json`'s `interchange.credentials` (CL-6028).
2. A workflow definition binds that handle via `credentialBindings`.
3. At launch, `buildCredentialDelivery` (`vendor/intx/db/src/
credential-resolution.ts`) resolves the binding against a tenant-owned
   credential, decrypts its secret once, and stamps a `credential:{id}` /
   `use` grant scoped to the tool package's consumer identity
   (`toolConsumer(packageName)`).
4. The resolved `CredentialDelivery` and the run's grants ride the deploy
   frame and every `credentials-updated` control frame into the
   workflow-process child (`vendor/intx/workflow-host/src/child/
run-child.ts`), which threads them to every step invocation as
   `CredentialWiring` -- `ChildStepInvoker`'s 6th argument.
5. The sidecar's `invokeStep` binding
   (`apps/sidecar/src/workflow-substrate-factory/index.ts`) threads that
   wiring into the per-step env (`step-env.ts`'s `attachStepCredentials`).
6. `createToolBearingAgentFactory` (`apps/sidecar/src/
step-agent-tools.ts`) derives each tool factory's consumer identity
   from its own declared `id`, and shapes a consumer-scoped `credentials`
   capability via the platform's `createCredentialCapability`
   (`@intx/harness/src/credential-capability.ts`) -- the same
   fail-closed, per-`{tool}`-condition gate the launch-time grant sets up.
7. The tool bundle calls `env.credentials.resolve(handle)` and gets a
   mediated `fetch`, never the raw secret. An unbound handle or a denied
   grant makes `resolve()` throw; the tool catches it and reports "not
   connected" rather than failing the step.

## Provider plugins

A credential's `provider` row names a `plugin` -- the `CredentialProvider`
key its bindings shape through. The sidecar's `CredentialProviderRegistry`
registers:

- **`http`** -- `@intx/harness`'s vendored `createHttpCredentialProvider`.
  Sends `authorization: Bearer <secret>`. The default for any bearer-token
  API (Granola's, for example).
- **`http-raw-authorization`** -- `@corbits/credential-providers`'s
  `createHttpRawAuthorizationCredentialProvider`. Sends the secret
  verbatim in `authorization`, no `Bearer ` prefix. Linear's API expects
  this raw-key convention, not a bearer token, so a Linear provider row
  MUST set `plugin: "http-raw-authorization"` -- seeding it as `"http"`
  sends the wrong header shape and Linear rejects the call.
- **`http-x-api-key`** -- `@corbits/credential-providers`'s
  `createHttpXApiKeyCredentialProvider`. Sends the secret in `x-api-key`.
  Exa and ScrapeCreators expect this header, not `authorization`.
- **`http-x-manus-api-key`** -- `@corbits/credential-providers`'s
  `createHttpXManusApiKeyCredentialProvider`. Sends the secret in
  `x-manus-api-key`. A Manus provider row MUST set this plugin -- seeding
  it as `"http"` or `"http-x-api-key"` sends the wrong header name and
  Manus rejects the call.
- **`mcp-streamable-http`** -- `@corbits/credential-providers`'s
  `createMcpStreamableHttpCredentialProvider`. For a token-bearing MCP
  server it sends `authorization: Bearer <token>`; for a keyless one
  (`MCP_NO_TOKEN_SENTINEL`) it sends no authorization header. The vendored
  `http` plugin cannot express the keyless case.

All five plugins the sidecar registers mirror the same origin-pinning and
`redirect: "manual"` protections; only the injected header (or its
absence, for keyless MCP) differs.

`templates/connectors.ts` (the concrete connector set a build passes into
`@corbits/connections`) is the other place this plugin id needs to be
correct: a Linear connector descriptor there must set
`plugin: "http-raw-authorization"`, and a Manus one must set
`plugin: "http-x-manus-api-key"`, matching this doc, not the `"http"`
default other connectors use.

## Trust boundary

`createToolBearingAgentFactory` derives a tool factory's consumer
identity from the factory's own self-declared `id`
(`defineTool({ id, ... })`) -- there is no loader-side check binding that
`id` to the package the factory actually shipped in. This is acceptable
only because tool packages are operator-installed, root-bucket-trusted
code (AGENTS.md: root-bucket modules "may declare routes, migrations,
credentials, and grants"; sandboxed installables never reach this path).
It is not a boundary that would hold against an untrusted or sandboxed
tool package. See the comment on `packageFromToolId`
(`apps/sidecar/src/step-agent-tools.ts`) for the same note in code; the
loader-side provenance check this implies for a future untrusted-package
story is tracked as its own follow-up, not solved here.

## Rotation reaches live agents (CL-6687)

Inference sources -- the decrypted provider key included -- are resolved
at deploy time and rendered into the run's bytes; nothing re-reads them
while the run is resident. So a rotated key (Settings > AI providers,
disconnect + reconnect after a 401) used to reach only the _next_ deploy,
and an already-open workbench kept sending the dead key until the stack
restarted.

Every deploy now records `inferenceSourcesDigest` (a SHA-256 over the
resolved chain, secret included; the secret itself is never stored) on
the run's `workbench_launch` row. Two paths compare it against today's
resolution and relaunch the run on a mismatch, the same relaunch a
definition-content drift triggers (CL-6588):

- `reconcileDriftedRun`, ahead of every send, so the next message in an
  open room uses the new key even if nothing else fired.
- `reconcileInferenceSources(tenantId)`, kicked by the hub the moment an
  inference provider's `/complete` stores a credential, so the fix an
  operator just applied lands without waiting for a message.

Re-saving the same key produces the same digest and relaunches nothing.
A run whose row predates the column (`sources_digest IS NULL`) gets
today's chain recorded as its baseline on its first check and is left
alone that once. The per-send check is throttled to one resolution per
participant per 30 seconds; the provider-connect hook is the path that
reaches live rooms immediately.
