# Credential wiring: from connect to tool call (CL-6032)

How a tenant's connected credential (Settings · Connections) reaches the
tool call a workflow step makes, and the two `CredentialProvider` plugins
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
key its bindings shape through. Two are registered in the sidecar's
`CredentialProviderRegistry`:

- **`http`** -- `@intx/harness`'s vendored `createHttpCredentialProvider`.
  Sends `authorization: Bearer <secret>`. The default for any bearer-token
  API (Granola's, for example).
- **`http-raw-authorization`** -- `@corbits/credential-providers`'s
  `createHttpRawAuthorizationCredentialProvider`. Sends the secret
  verbatim in `authorization`, no `Bearer ` prefix. Linear's API expects
  this raw-key convention, not a bearer token, so a Linear provider row
  MUST set `plugin: "http-raw-authorization"` -- seeding it as `"http"`
  sends the wrong header shape and Linear rejects the call. Both plugins
  mirror the same origin-pinning and `redirect: "manual"` protections;
  only the injected header value differs.

`packages/connections` (the Connections-surface registry) is the other
place this plugin id needs to be correct: whatever seeds or registers a
Linear provider row there must set `plugin: "http-raw-authorization"`,
matching this doc, not the `"http"` default other connectors use.

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
