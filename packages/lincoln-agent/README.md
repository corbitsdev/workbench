# @corbits/lincoln-agent

Lincoln: a LinkedIn writing agent, ported from the OG gtm-workbench's
`packages/agents/src/lincoln`. Drafts substantive, paste-ready LinkedIn
posts grounded in real field observations.

## What changed from the original

The original called `firecrawl_scrape`/`firecrawl_search` to fetch
specific context URLs before drafting. Workbench has no firecrawl
integration, so this port rebinds that to `@corbits/web-search-tools`'
`web_search` (Exa-backed) — Lincoln now searches by topic for grounding
rather than scraping a given URL list.

`web_search` already degrades honestly: a missing Exa credential
resolves to a plain "not connected" tool result, never a thrown error
or a silent empty reply. Lincoln's prompt reflects that — when search
isn't connected, he says so in one sentence and drafts from the
conversation instead of stalling on a connection he doesn't have. Exa
is optional, not required: nothing here blocks Lincoln from working
the moment he's installed.

The original's "no durable memory tool" and "no file-write tool"
disclaimers carry over as-is — workbench has no equivalent for either
today.
