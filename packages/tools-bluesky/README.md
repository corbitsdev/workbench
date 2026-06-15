# @workbench/tools-bluesky

Bluesky search tool for the last30days research pipeline.

Exposes `bluesky_search({ query, days })` which calls the Bluesky public API and returns normalized `ResearchItem` objects compatible with `@workbench/last30days-core`.

Authentication is optional. If `BLUESKY_IDENTIFIER` and `BLUESKY_APP_PASSWORD` env vars are set, requests are sent with Basic auth. Unauthenticated requests use the public `https://public.api.bsky.app` endpoint.
