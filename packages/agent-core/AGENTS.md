# @workbench/agent-core

Base leaves shared by `@workbench/agents` and `@workbench/myra`: tool-name
canonicalization, the shared tool-call phrase table, LLM constants, and the
Corbits vocabulary prompt section. No agent-specific definitions here — only
the pieces both packages needed that used to create a package cycle between
them.

`src/parts.ts` additionally holds the chat message/part data model — the
`ChatMessage`/`Part` arktype schemas and the `liftToParts` /
`toolPartToCall` adapters. It lives here rather than in `@workbench/chat`
(a frontend-only package) because `@workbench/agents` — which sits in the
sidecar's runtime closure — builds and consumes these shapes
(`convertInstanceEvents`, `composeChatMessages`, `createPartAssembler`), and
the sidecar image must never copy frontend source. `@workbench/chat`
re-exports this module from its `./types` and `./parts` subpaths so
existing web/renderer imports are unaffected.

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
