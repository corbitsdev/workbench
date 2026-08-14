# @corbits/granola-tools

A minimal Granola integration: two client calls, one `@intx/agent` tool
bundle. Built for the morning-brief workflow (CL-5993); `granola_get_note`
was added by the pain-point-collateral workflow (CL-5995) — neither is
specific to its origin workflow, so both stay in this one package rather
than forking a second Granola client.

## Tools

- `granola_list_recent_notes` — lists the caller's recent call notes
  (`id`, `title`, `summary`, `createdAt`), optionally filtered to notes
  created after a given ISO 8601 timestamp.
- `granola_get_note` — fetches one call note by id, including its
  transcript (`speaker`/`text` lines).

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
