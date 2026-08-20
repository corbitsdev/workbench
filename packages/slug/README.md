# @corbits/slug

The URL-facing name of an entity. Agents, skills, plugins, and routines are
addressed by slug (`/agents/triage-bot`), not by opaque id, so the two
directions of that mapping live in one place: `slugify` derives a slug from
a display name, `isValidSlug` says whether a string read off a URL is a
slug at all.

Pure string functions, no dependencies — safe in the browser bundle and in
hub code alike.

## Composition with @intx/\*

None. Ids belong to Interchange (`@intx/*`); a slug is the human-readable
name beside an id, never a replacement for one.

## Key modules

- `src/slug.ts` — `slugify` (accents folded to ASCII, non-alphanumerics
  collapsed to single hyphens, capped at `SLUG_MAX_LENGTH`), `isValidSlug`
  (exactly the shape `slugify` produces).
- `src/index.ts` — re-exports both plus `SLUG_MAX_LENGTH`.

Uniqueness is not a property of a string: a slug is unique per tenant per
entity kind, enforced by the owning table's constraint, not here.

## Running tests

```
cd packages/slug && bun test
```
