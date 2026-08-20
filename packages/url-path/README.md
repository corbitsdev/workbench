# @corbits/url-path

The one guarded decode for a URL path segment or param. `decodeURIComponent`
throws on a malformed percent-escape, and a hand-typed or truncated URL can
carry one — so every route parser and deep-link helper that reads a path
segment shares `decodedOrNull` instead of calling `decodeURIComponent`
directly. A segment that cannot be decoded names no entity, so it reads as
no selection (or a `400 bad_request` on a server route) rather than taking
the render — or the request — down with it.

Pure string function, no dependencies — safe in the browser bundle and in
hub code alike.

## Key modules

- `src/decoded-or-null.ts` — `decodedOrNull`.
- `src/index.ts` — re-exports it.

## Running tests

```
cd packages/url-path && bun test
```
