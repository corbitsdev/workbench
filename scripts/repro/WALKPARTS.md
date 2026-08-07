# `@intx/mime` leaf part defect

**API path:** `extractPartByPath(raw, partPath)` (exported from
`@intx/mime`) → internal `walkParts` in `src/mime.ts`.

**Input:** a `multipart/signed` message wrapping a `multipart/mixed` body
with one `text/plain` part and one attachment part (`Content-Transfer-Encoding:
base64`) — built with `assembleSignedContent({ kind: "conversation", ... })`

- `assembleMessage(...)`. Fetched with `extractPartByPath(raw, "1.2")`
  (part 1 = the signed content, part 2 = the attachment within it).

**Expected:** the decoded attachment body, e.g. `"hello attachment body"`.

**Actual:**

```
Content-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="note.txt"\r\n\r\naGVsbG8gYXR0YWNobWVudCBib2R5
```

The leaf slice still carries its own header block and un-decoded base64
body.

**Offending code:** `src/mime.ts`, `walkParts`, the leaf-return branch:

```ts
if (depth + 1 === steps.length) {
  return partBytes; // src/mime.ts:738-739
}
```

Every non-leaf depth calls `parseMimePart(partBytes)` to strip headers and
get `part.body` before recursing further (line 743), but the leaf case
skips that step and returns the raw `parseMultipart` slice untouched.

**Suggested fix:** apply the same `parseMimePart` step to the leaf, then
transfer-decode `part.body` per its `Content-Transfer-Encoding` header
(base64/quoted-printable/7bit) before returning, so `extractPartByPath`
returns a decoded body at every depth, not just intermediate ones.

Reproducer: `scripts/repro/walkparts-repro.ts` (`bun run
scripts/repro/walkparts-repro.ts`, no DB/network/env required).
