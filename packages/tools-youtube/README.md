# @workbench/tools-youtube

YouTube Data API v3 tool for last30days research. Exposes `youtube_search` which searches recent videos and returns `ResearchItem[]` with engagement data (views, likes, comments).

## Tool

### `youtube_search`

Searches YouTube for videos published within the last N days.

**Parameters:**

- `query` (required): search query string
- `days` (optional): days to look back, default 30

**Returns:** JSON-serialized `ResearchItem[]` with `source: 'youtube'`.

## Implementation

Two YouTube Data API v3 calls per request:

1. `search.list` — fetches video IDs + snippets matching the query
2. `videos.list` — fetches statistics (viewCount, likeCount, commentCount) for those IDs

Engagement mapping:

- `likeCount` → `engagement.upvotes`
- `commentCount` → `engagement.comments`
- `viewCount` → `engagement.views`

`topComments` is not supported — `ResearchItem` has no `topComments` field. See INTEGRATION.md.

## Credential

Requires a YouTube Data API v3 key. Provider name: `youtube`.

## Development

```bash
bun test src
bun run typecheck
```
