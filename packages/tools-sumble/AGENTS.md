# @workbench/tools-sumble

Sumble **v9** API tools registered in the hub as `sumble_*` read/write tools via
`SUMBLE_HUB_TOOLS` (`src/registry.ts`).

- Credential (`sumble` provider) resolves at tool execution — not at agent launch
- Tool grants `tool:sumble_*/invoke` are synthesized from agent capabilities
- Keep agent prompts aligned with `src/definitions.ts`
- OpenAPI parity is enforced in `src/openapi-parity.test.ts` and
  `src/operation-coverage.ts`

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
