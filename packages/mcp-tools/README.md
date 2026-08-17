# @corbits/mcp-tools

A tool package that lets any agent reach a Streamable-HTTP MCP server
connected under a workbench's Plugins gallery — discovery and invocation,
without a bespoke tool package per MCP server.

## Connecting a server

Plugins → Add MCP server takes a full endpoint URL (stored as-is, not just
its origin — see `packages/connections/src/mcp-server-routes.ts`) and an
optional bearer credential. Granola, Exa, and Linear render as one-click
preset cards (`packages/plugins-ui/src/mcp-preset-cards.tsx`) that connect
via the same routes without the person typing a URL.

## Tools

`mcpTools` (`src/tool.ts`) declares four:

- **`mcp_list_servers`** — read-only. Lists the workbench's currently
  connected MCP servers: each one's slug and display name.
- **`mcp_list_tools`** — read-only. Discovery, in four modes, narrowest
  first:
  - no arguments — a catalog of every connected server with its tool
    names and **truncated** descriptions, for a first skim.
  - `{ pattern }` — regex-searches tool and server names across every
    connected server, for when it's unclear which server has the tool.
  - `{ server }` — one server's full tool list with full descriptions.
  - `{ server, toolName }` — one tool's full input schema.
- **`mcp_read`** — calls a tool on a connected server without human
  approval. Only works when that server's live `tools/list` marks the
  tool `readOnlyHint: true` — re-checked at call time, never assumed from
  the model's claim (`readOnlyGate` in `src/tool.ts`). Errors, pointing at
  `mcp_call`, when the tool isn't marked read-only.
- **`mcp_call`** — calls any tool, read or write, on a connected server.
  Gated `approval: "ask"` unconditionally: one downstream MCP server can
  bind under any name at deploy time, so a single grant for `mcp_call`
  covers every server, and a downstream tool's own `readOnlyHint` cannot
  lower that gate dynamically (see `src/tool.ts`'s header comment).

## Authz split

`mcp_list_servers`/`mcp_list_tools` carry no `approval` key (read, like
`@corbits/connections-tools`' `list_connections`). `mcp_read` is allowed
outright but re-validates `readOnlyHint` live before every call. `mcp_call`
always asks for approval, regardless of the downstream tool's own
annotations.
