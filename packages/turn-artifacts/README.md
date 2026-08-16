# @corbits/turn-artifacts

Recognizes a persisted Library artifact in a finalized turn's tool-call
results (CL-6000). A workflow's finalize tool persists via the sanctioned
workflow-artifacts HTTP surface (`@corbits/artifacts-hub`'s
`createWorkflowArtifactRoutes`) and returns the artifact's id/title/kind
in its `ToolResult.content` JSON; this package parses that shape — and
only that shape — out of a turn's tool calls.

## Composition

Lifted out of `@corbits/chat` so every delivery surface (chat messages,
task results) reads the same facts without depending on chat itself. The
package is deliberately structural: it reads a minimal
`FinalizedTurnToolCall` shape (`result`, `isError`) rather than importing
`@intx/hub-sessions`' `TurnFinalized`/`TurnToolCall` types, since that
vendored package doesn't export them past its own internal module. Every
real `TurnToolCall` satisfies the structural shape. No runtime dependency
on `@corbits/artifacts-hub` or `@corbits/chat` — arktype is the only
dependency.

## Key modules

- `index.ts` — the entire package:
  - `persistedArtifactsForToolCall` — parses one tool call's result for a
    single `{id, title, kind, persisted: true}` or batched
    `{artifacts: [...]}` shape; an errored call, unparseable JSON, or a
    non-matching shape yields nothing (never guesses).
  - `persistedArtifactsForFinalizedTurn` — flat-maps every persisted
    artifact named across a finalized turn's tool calls.
  - `FinalizedTurnToolCall`, `PersistedArtifact` — the input/output types.

## Tests

```
cd packages/turn-artifacts && bun test
```

No database or network dependency — pure parsing logic.
