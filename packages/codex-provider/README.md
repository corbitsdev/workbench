# @corbits/codex-provider

An Interchange inference provider for OpenAI Codex ("Login with ChatGPT"):
OAuth constants and token mapping for `@corbits/oauth-core`, and a
Responses-protocol adapter for Codex's ChatGPT backend built on
`@corbits/openai-responses`. It does not implement login flow orchestration,
token storage, or usage/quota reporting — a host composes those itself from
`@corbits/oauth-core` directly.

This is a private in-repo workspace package; the workspace resolves it by
name. The package ships TypeScript source and needs no build step; Bun
consumes it directly.

## Usage

```ts
import type { AdapterManifest } from "@intx/inference";
import { createDefaultScheduler } from "@intx/inference";
import { loadAdapterRegistry } from "@intx/inference/providers";
import type { InferenceSource } from "@intx/types/runtime";
import { withCodexContentTypeRepair } from "@corbits/codex-provider";

const manifest: AdapterManifest = [
  {
    provider: "codex",
    specifier: "@corbits/codex-provider",
    export: "createCodexResponsesAdapter",
  },
];

const adapters = await loadAdapterRegistry(manifest);
const dependencies = {
  adapters,
  fetch: withCodexContentTypeRepair(fetch),
  scheduler: createDefaultScheduler(),
};

// Quirks ride on the `InferenceSource` the harness resolves at call time,
// not on the manifest entry:
const source: InferenceSource = {
  id: "codex/1",
  provider: "codex",
  baseURL: "https://chatgpt.com/backend-api",
  apiKey: "",
  model: "gpt-5.5",
  quirks: {
    productName: "My Harness",
    environmentTagName: "my_harness_environment",
  },
};
```

`codexOAuthConfig`, `exchangeCodexCode`, and `refreshCodexTokens` plug
directly into `@corbits/oauth-core`'s `startOAuthLogin` and
`createTokenSession`, as shown in that package's own README.

## API

See `src/index.ts` for the full public surface and its TSDoc; the Codex
`quirks` shape is `CodexQuirks` in `src/quirks.ts`.

## Design notes

- Codex has no separate API-key credential path — only the ChatGPT OAuth
  subscription token is supported.
- A host's own operating prompt rides as the leading `developer` message
  via `wrapCodexBridgeMessage`. This package does not send an
  `instructions` field.
- `CodexQuirks` (`productName`, `environmentTagName`) has no default: there
  is no honest generic product name, so an absent quirks bag is a
  validation error, not a silently-generic adapter.
- `createCodexResponsesAdapter` is a plain `(source, quirks?)`
  `AdapterFactory`, loadable from an `AdapterManifest` entry like any other
  provider.
- `withCodexContentTypeRepair` exists because the backend omits
  `content-type` on some streamed responses despite a valid SSE body; it
  restores the header from the request's own `accept` commitment rather
  than guessing.
- Requests identify as the public Codex CLI (`originator: codex_cli_rs`,
  the CLI's own OAuth client id) because the ChatGPT backend only serves
  that client; the ChatGPT subscription token from that login is the only
  credential this package uses, and OpenAI closing that door is an outage
  this package cannot route around, not a bug in it.

## Not supported

- No API-key credential path — Codex has none.
- No live model catalog (`GET /codex/models`) — a host that needs one fetches
  it itself.
- No usage/quota or rate-limit surfaces — out of scope for an inference
  provider adapter.
- No login flow orchestration or token storage — call `@corbits/oauth-core`
  directly with `codexOAuthConfig`.

## License

LGPL-2.1-or-later.
