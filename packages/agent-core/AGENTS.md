# @workbench/agent-core

Base leaves shared by `@workbench/agents` and `@workbench/myra`: tool-name
canonicalization, the shared tool-call phrase table, LLM constants, and the
Corbits vocabulary prompt section. No agent-specific definitions here — only
the pieces both packages needed that used to create a package cycle between
them.

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
