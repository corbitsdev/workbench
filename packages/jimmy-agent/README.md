# @corbits/jimmy-agent

Jimmy: a one-shot chat agent that searches Giphy and replies with a GIF.
Everything Jimmy needs — system prompt, tool declaration, and the Giphy
tool body — lives in this one package, per the portable-agent-package
convention (`defineAgent`'s "portable half," `corbitsdev/examples`).

## What's ported (from `scout/packages/jimmy`)

- The Giphy search HTTP client and response parsing (`gif-search-tool.ts`,
  from `giphy-search.ts`).
- The system prompt and agent shape (`agent.ts`, from `index.ts`'s
  `jimmyPackage`), trimmed to one tool call and one reply.

## What's deferred

- **Slack dispatch, block-kit rendering, and the `/gif` `/jimmy` slash
  commands** — Slack-specific, out of scope for v0.1 per the owner.
- **The 4-up picker and the shuffle/cancel signal machine**
  (`scout/workflows/jimmy`) — built for Slack's interactive buttons.
  Workbench chat has no equivalent affordance yet, so Jimmy ships the
  simple path only: one request, one GIF, no follow-up picker.
- **Wiring `gif_search`'s "giphy" credential handle to a real connector.**
  This package resolves its credential through the same
  `CredentialCapability.resolve("giphy")` seam every other tool package in
  this repo uses (see `@corbits/web-search-tools`'s `tool.ts`), so once a
  `giphy` connector exists it works with zero code changes here. As of
  this package's introduction, that connector does not yet exist:
  `packages/connections/src/registry.ts`'s `CONNECTOR_REGISTRY` has no
  `giphy` entry, and none of its three credential-provider plugins
  (`http`, `http-raw-authorization`, `http-x-api-key`) put the secret on
  the query string the way Giphy's `/v1/gifs/search` endpoint requires —
  a fourth plugin (mirroring `http-x-api-key-provider.ts`, injecting into
  the URL's search params instead of a header) is the missing piece.
  Until both land, `gif_search` always returns the "connect Giphy"
  message, by design — never a silent failure.
- **Installing Jimmy as a mentionable chat agent.** This package exposes
  `buildJimmyAgent`, an `AgentDefinition` ready to seed through
  `packages/agent-directory`'s create path (the same path
  `@corbits/code-review`'s reviewer agents install through) — that
  seeding call is not wired in this change.

## Test plan run

`bun test` inside this package: a stubbed Giphy response produces a GIF
CDN URL, and an unbound/absent credential returns a "connect Giphy"
`isError` result rather than throwing or replying empty.
