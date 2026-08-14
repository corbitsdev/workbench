# @corbits/credential-providers

Workbench-owned `CredentialProvider` plugins for auth schemes the vendored
`@intx/harness` `http` provider doesn't cover (CL-6032).

## `http-raw-authorization`

`@intx/harness`'s built-in `createHttpCredentialProvider` (key `http`)
always sends `authorization: Bearer <secret>` — correct for a
bearer-token API, wrong for Linear's, which expects the raw key with no
`Bearer ` prefix in `authorization`. `createHttpRawAuthorizationCredentialProvider`
(key `http-raw-authorization`) mirrors the vendored provider's
origin-pinning and `redirect: "manual"` protections exactly; only the
injected header value differs.

Register it alongside the vendored built-ins in the sidecar's
`CredentialProviderRegistry`:

```ts
import {
  builtinCredentialProviders,
  createCredentialProviderRegistry,
} from "@intx/harness";
import { createHttpRawAuthorizationCredentialProvider } from "@corbits/credential-providers";

const providers = createCredentialProviderRegistry([
  ...builtinCredentialProviders(),
  createHttpRawAuthorizationCredentialProvider(),
]);
```

A tenant's Linear credential's `provider` row must set `plugin:
"http-raw-authorization"` (not `"http"`) for its bindings to send the
header Linear's API actually expects. Every other provider row that
authenticates with a bearer token keeps `plugin: "http"`.
