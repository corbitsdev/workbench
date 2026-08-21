# @corbits/scout-agent

Scout, ported from the standalone [scout](https://github.com/corbitsdev/scout)
repo (CL-6499): the system prompt, the tool declarations, and Scout's own
Library-artifact tool — everything one chat agent needs, in one package.

## What's ported and how it's wired

| Original tool            | Status                         | Wired to                                                                                                         |
| ------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `knowledge-search`       | ported as `memory_search`      | `@corbits/memory-tools` (existing, unmodified)                                                                   |
| `memory-add`             | ported as `memory_add`         | `@corbits/memory-tools` (existing, unmodified)                                                                   |
| `memory-list`            | ported as `memory_list`        | `@corbits/memory-tools` (existing, unmodified)                                                                   |
| `web-research`           | ported as `web_search`         | `@corbits/web-search-tools`, Exa-backed, credential handle `"exa"` (existing, unmodified)                        |
| `artifacts`              | narrowed to save + list-recent | `./src/artifact-tool.ts` (new, this package), against `@corbits/artifacts-hub`'s workflow-artifacts HTTP surface |
| `launch-diligence-brief` | **deferred, dropped**          | —                                                                                                                |
| `launch-fact-check`      | **deferred, dropped**          | —                                                                                                                |

Scout's own tool bodies were never portable as-is: scout's
`docs/design/scout-core-purity.md` says the core/surface split that would
make them portable isn't built yet (CL-5143), and its own
`packages/scout/README.md` says its tools "compile into this repo's
sidecar rather than arriving as pinned, published packages" (CL-5179).
Only the declarations — the system prompt and the tool schemas — are
ported. Everything each tool calls is workbench's own existing
infrastructure.

## Known gaps vs. the original Scout

- **No diligence brief, no fact-check.** The two workflow-launching tools
  are gone from both the tool list and the prompt (see
  `./src/system-prompt.ts`'s header comment) — a ~2,600-line pipeline
  (`workflows/diligence-brief/`, `workflows/diligence/`) that this port
  does not carry. This Scout answers questions and remembers things; it
  does not run a diligence pipeline. Someone who knows the Slack Scout
  will notice this immediately — it's the biggest capability gap.
- **`artifacts` is narrower.** The original backed `artifact-search` (by
  company/kind/query, with brief-freshness bands) and `artifact-read`
  (paginated open-by-ref) against Scout's own hub API.
  `@corbits/artifacts-hub`'s workflow-artifacts HTTP surface only offers
  create and list-recent (no search-by-field, no read-by-id, no
  pagination), so `scout_save_artifact`/`scout_list_recent_artifacts` is
  what's actually available.
- **No per-principal attribution.** The original attributed every
  read/write to the Slack-message's triggering principal
  (`getTriggerPrincipal()`). This port's tools attribute to whatever
  principal/tenant the deploying agent binds at runtime — the same model
  every other tool package in this catalog (`@corbits/memory-tools`,
  `@corbits/web-search-tools`) already uses, not a Scout-specific
  regression.

## Requires connecting

`web_search` needs the Exa MCP preset connected (keyless — no API key,
just add it under Plugins). `scout_save_artifact`/
`scout_list_recent_artifacts` need the Library/artifacts plane mounted
(already true wherever CL-5291 landed). A missing connection surfaces as
an honest `isError: true` tool result naming the gap — never a silent
failure or a fabricated answer.

## Not done in this port

Registering `SCOUT_AGENT_DEFINITION` into a live workbench (the
agent-directory create path, `packages/agent-directory`) is a follow-up,
not part of this package. This package is the portable definition only —
see `corbitsdev/examples`' `starter/agent-quickstart/README.md` for the
`defineAgent`/`createAgent` split this follows.
