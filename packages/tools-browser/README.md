# @workbench/tools-browser

Granular browser-control tools over a [Browserbase](https://browserbase.com)-hosted
browser. The tools are the hands; the agent is the reasoning loop. `act` /
`extract` / `observe` are NOT tools here — they are a prompt skill on the agent,
because hub tools cannot reach inference.

Each tool reconnects to the Browserbase session over CDP, performs one action,
and disconnects. The live browser lives on Browserbase, keyed by a `sessionId`
the agent passes as a tool argument; no browser state is held in this process
beyond the connectUrl store.

## Module layout

| File          | Owns                                                                    |
| ------------- | ----------------------------------------------------------------------- |
| `budgets.ts`  | The four timeout constants and their ordering invariant. Zero imports.  |
| `config.ts`   | Base-URL / project-id parsing, `resolveConfig`, session-timeout clamp.   |
| `schemas.ts`  | ArkType schemas for the Browserbase REST responses we read.             |
| `client.ts`   | Browserbase REST client (one fetch helper) + the connectUrl store.      |
| `cdp.ts`      | CDP connect (the only importer of `chromium`), `getPage`, `withTimeout`. |
| `snapshot.ts` | Page snapshot script + pure pruning/ref logic.                          |
| `tools.ts`    | Tool definitions, `createBrowserTools`, the hub registry.               |
| `index.ts`    | Thin barrel: the public surface only.                                   |

## Credentials

Browserbase is a **tool** provider, not an inference provider. Keep
`browserbase` in the consuming agent's `credentialProviderNames` (so the UI asks
for it) and let the hub tool registry resolve it at execution time. Never add it
to an agent's `credentialRequirements`. The hub passes a single `baseURL` per
credential; the Browserbase project id rides on it as `?projectId=<id>` and is
split out in `config.ts`.

## Errors and logging

The package throws on failure and does **not** log. The hub catches every tool
error at the boundary (`apps/hub/src/routes/tools.ts`) and logs it there, so
logging here would double-log and split ownership. There is intentionally no
`@intx/log` dependency.

## Testing

Two seams, two mechanisms — deliberately asymmetric:

- **The Browserbase REST client is injected** as the optional `fetcher` config
  field (defaulting to global `fetch` in `resolveConfig`). It is data-plane
  state, so per AGENTS.md it is injected as an argument. This also matches the
  sibling `@workbench/tools-firecrawl`.
- **The CDP browser is mocked at the `playwright-core` module boundary** — the
  one place the package imports it. `playwright-core` is a heavyweight external
  module, so per AGENTS.md it is mocked with `mock.module(...)`, not injected.

`fixtures.ts` holds the shared stubs and `playwrightMockFactory`. A test file
that drives CDP installs the mock itself at the top of the file:

```ts
import { playwrightMockFactory, cdpControl } from "./fixtures";
mock.module("playwright-core", playwrightMockFactory);
import { connect } from "./cdp";
```

`mock.module` is hoisted above static imports only when it lives in the test
file itself; buried in an imported module it runs too late. Set `cdpControl`
before each test to program the fake browser.

Do not "fix" the asymmetry by injecting playwright or by mocking `fetch` — it is
load-bearing.
