# @corbits/granola-tools

A minimal Granola integration: one client call, one `@intx/agent` tool
bundle. Built for the morning-brief workflow (CL-5993) but not specific
to it — any agent that needs a user's recent Granola call notes pins
this package.

## Tool

`granola_list_recent_notes` — lists the caller's recent call notes
(`id`, `title`, `summary`, `createdAt`), optionally filtered to notes
created after a given ISO 8601 timestamp.

## Credential

The bundle's env requires `granolaApiKey`. When it is absent or empty,
the tool never throws — it returns a completed result with
`isError: true` and content naming the source "not connected", so a
calling agent can degrade gracefully instead of failing its turn.

## Usage

```ts
import { granolaTools } from "@corbits/granola-tools";

const agent = defineAgent({
  // ...
  tools: [granolaTools],
});
```
