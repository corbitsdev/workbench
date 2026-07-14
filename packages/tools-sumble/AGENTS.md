# @workbench/tools-sumble

Sumble **v9** API tools (**32** hub tools, **25** HTTP operations) registered via
`SUMBLE_HUB_TOOLS` (`src/registry.ts`).

- Credential (`sumble` provider) resolves at tool execution — not at agent launch
- Default API root is `https://api.sumble.com` with `/v9/` paths (`src/http.ts`)
- Ergonomic tools wrap common shapes; `sumble_post_*` pass verbatim bodies (with
  spend guards on `sumble_post_people` email/phone select)
- Credit gates: `confirmSpend` (brief), `confirmEmailRevealSpend` (people email /
  email identifier lookup)
- OpenAPI parity: `src/openapi-parity.test.ts`, `src/operation-coverage.ts`
- After registry changes: `cd apps/hub && bun run build:tool-manifests`

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
