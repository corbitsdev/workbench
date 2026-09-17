# @corbits/connections-tools

`list_connections` and `request_connection`, an agent's in-chat way to
see which third-party connections (Attio, Exa, Granola, ...) a workbench
already has live, and to hand a human a link to connect one that isn't.
Neither tool completes OAuth or invents new state; connecting itself
always finishes in the browser.

This package carries no connector set of its own. The deploying build
wires its own registry/preset list into `WorkflowConnectionEnv`
(Workbench passes its own `@corbits/connections` `CONNECTOR_REGISTRY` and
`MCP_PRESETS`), so `./src/registry-shape.ts` declares only the minimal
`ConnectorRegistry`/`McpPreset` field shapes this tool actually reads
plus the one lookup helper (`mcpPresetByName`) — the caller's richer
descriptor objects satisfy these structurally.

`list_connections` is read-only. `request_connection` posts a
connect-service card into the caller's own room; neither tool is
approval-gated (see `./src/tool.ts`'s header comment for why).
