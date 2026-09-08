# @corbits/xai-provider

xAI/Grok's PKCE OAuth config and token mapping over `@corbits/oauth-core`, a
base URL for a plain API key, and a Responses adapter configured for xAI's
CLI chat proxy over `@corbits/openai-responses`. It does not run a login
flow or manage a session itself — a host wires those from the two
dependency packages directly.

This is a private in-repo workspace package; the workspace resolves it by
name. The package ships TypeScript source and needs no build step; Bun
consumes it directly.

## Usage

```ts
import type { AdapterManifest } from "@intx/inference";
import { createDefaultScheduler } from "@intx/inference";
import { loadAdapterRegistry } from "@intx/inference/providers";
import type { InferenceSource } from "@intx/types/runtime";
import { XAI_OAUTH_PROXY_BASE_URL } from "@corbits/xai-provider";

const manifest: AdapterManifest = [
  {
    provider: "xai",
    specifier: "@corbits/xai-provider",
    export: "createXaiResponsesAdapter",
  },
];

const adapters = await loadAdapterRegistry(manifest);
// Host wires `dependencies` (adapters, fetch, scheduler) as usual for
// @intx/inference.

// An OAuth (grok CLI) credential hits the CLI chat proxy and only serves
// XAI_DEFAULT_MODELS; a plain API key hits XAI_API_KEY_BASE_URL instead.
// The current access token goes on `apiKey` — the harness injects it at send.
const source: InferenceSource = {
  id: "xai/1",
  provider: "xai",
  baseURL: XAI_OAUTH_PROXY_BASE_URL,
  apiKey: "<access token>",
  model: "grok-4.5",
};
```

`xaiOAuthConfig`, `exchangeXaiCode`, and `refreshXaiTokens` plug directly
into `@corbits/oauth-core`'s `startOAuthLogin` and `createTokenSession`, as
shown in that package's own README. Persistence is the host (Interchange
`oauth_token` or OS vault).

## API

See `src/index.ts` for the full public surface and its TSDoc.

## Design notes

- OAuth login and session refresh are not reimplemented here — this package
  supplies only xAI's endpoints, client id, and token mapping; the host
  calls `@corbits/oauth-core` directly.
- Requests identify as the official grok CLI (`user-agent`,
  `x-grok-client-identifier`) because the CLI chat proxy only serves that
  client; a vendor policy change can break this package with no code
  change on our side.
- `xaiUserIdFromAccessToken` never verifies the JWT signature: it only
  labels a header value with the id the issuer already vouched for by
  issuing the token, never an authorization decision.
- The host chooses the provider id it registers `createXaiResponsesAdapter`
  under (`XAI_PROVIDER` is only a suggested default); `tagSignature` inside
  `@corbits/openai-responses` keys reasoning-signature replay on that id, so
  renaming it later invalidates previously stored signatures.

## Not supported

- OAuth credentials work only against the CLI chat proxy and only for
  `XAI_DEFAULT_MODELS`; a plain API key against `XAI_API_KEY_BASE_URL` is
  the path for anything else.
- No xAI-specific tools (e.g. Live Search).
- The pinned user-agent/client-version may need bumping if the proxy starts
  rejecting old versions; it also always claims `(macos; aarch64)`
  regardless of the host's actual OS, matching what the proxy expects from
  the official grok CLI.

## License

LGPL-2.1-or-later.
