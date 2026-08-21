# @corbits/gotenberg-render

Renders a Markdown [Library](../artifacts-hub) artifact to PDF through an
operator-configured [Gotenberg](https://gotenberg.dev) server (CL-6499),
and hands the resulting bytes to a caller-supplied sink to persist as a
new Library artifact — no new download mechanism, no artifact-shaped
document invented along the way.

## What this package does

- `resolveGotenbergConfig(env)` — reads `GOTENBERG_URL` and returns
  `{ baseUrl }`, or `null` when it's unset. `null` means the render
  capability is simply absent for this bench: callers must check for it
  before ever offering a "Download as PDF" action, rather than showing a
  button that errors or no-ops when clicked.
- `renderMarkdownToPdf(config, { title, markdown })` — POSTs the Markdown
  to Gotenberg's Chromium `convert/markdown` route and returns the PDF as
  `Uint8Array`. Throws `GotenbergRenderError` on any transport or non-2xx
  failure.
- `renderMarkdownArtifactToPdf(config, source, sink, context)` —
  orchestrates the above end to end: renders, then calls `sink.savePdf`
  to persist the PDF as a new artifact. On any failure it reports through
  `@corbits/error-sink` and returns a plain-language message
  ("Couldn't build the PDF. Try again shortly.") plus a `refId` — never a
  raw HTTP status or internal error to the person waiting on their brief.

`sink` and the Markdown `source` are both injected ports, not a concrete
artifact store: the caller wires in however it already reads a Library
artifact's content and however it already persists a new one (the tenant
Library's multipart `/upload` route being the one that currently accepts
arbitrary binary content — see "What's still missing" below).

## Turning this on

1. **Run a Gotenberg server.** It's normally a container; the official
   image needs no extra configuration for Markdown-to-PDF:

   ```sh
   docker run --rm -p 3000:3000 gotenberg/gotenberg:8
   ```

   Point it at wherever you run containers for this bench (a sidecar
   service, a small Railway service, etc.) — Gotenberg is stateless, so it
   scales horizontally with zero shared state.

2. **Set `GOTENBERG_URL`** on the process that calls this package to that
   server's base URL, e.g. `http://gotenberg:3000` or
   `https://gotenberg.internal.example.com`. Leaving it unset (the
   default) keeps the PDF-render capability off entirely — nothing here
   errors at startup either way.

3. **Wire a `PdfArtifactSink`** that persists the returned bytes as a new
   Library artifact with `mimeType: "application/pdf"`, and a source that
   reads the Markdown artifact's content, then call
   `renderMarkdownArtifactToPdf`.

## What's still missing for an end-to-end brief

Rendering itself works against any Markdown + a running Gotenberg
server. Two integration gaps remain before a real due-diligence brief can
go artifact-in, PDF-artifact-out with no glue code:

- The workflow-run artifact surface
  (`@corbits/artifacts-hub`'s `createWorkflowArtifactRoutes`, the one a
  Scout run authenticates against) has `POST /` (create) and
  `GET /recent` (list) but no `GET /:id` to fetch one artifact's content
  back — so a workflow run can't yet read the Markdown brief it just
  saved in order to hand it to this package.
- That same workflow surface stores `content` as a JSON string capped at
  64k characters — it has no path for binary content. The only route
  today that accepts arbitrary bytes (`POST /upload` on the tenant
  Library surface) is authenticated by browser tenant session, not a
  workflow run's sidecar token. Persisting a rendered PDF from inside a
  workflow run needs one of those two surfaces extended; this package's
  `PdfArtifactSink` port is deliberately shaped so that extension is a
  drop-in once it exists.
