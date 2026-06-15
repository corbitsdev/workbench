# @workbench/tools-bluesky

Bluesky search tool for the last30days research pipeline.

Exposes `bluesky_search({ query, days })` which calls the Bluesky public API and returns normalized `ResearchItem` objects compatible with `@workbench/last30days-core`.

No credential is required: the tool queries the unauthenticated Bluesky AppView (`https://public.api.bsky.app`). Authenticated reads would need a real AT Protocol `createSession` -> JWT bearer flow (not HTTP Basic); that is out of scope until a use case requires it.
