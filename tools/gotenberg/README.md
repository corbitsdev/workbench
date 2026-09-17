# @corbits/gotenberg

Renders a Markdown document to PDF through an operator-configured
[Gotenberg](https://gotenberg.dev) server: a thin HTTP client and one
`@intx/agent` tool bundle.

## Tools

- `gotenberg_render_pdf` — renders a Markdown document (`title`,
  `markdown`) to PDF and returns it as base64-encoded bytes plus a
  filename and MIME type.

## Credential

The bundle's env carries `credentials`, the harness's consumer-gated
`CredentialCapability`. When it is absent, or
`credentials.resolve("gotenberg")` throws — no bound handle, or a grant
that doesn't authorize this consumer — the tool never throws itself: it
returns a completed result with `isError: true` and content naming the
source "not connected".

This package declares one credential handle, `gotenberg`, in its
`package.json`'s `interchange.credentials` field. The bound credential's
origin is the operator's Gotenberg server address — connect it once in
Settings · Connections, and every workflow that pins `@corbits/gotenberg`
and binds this handle resolves the same bench-owned credential.

## Running Gotenberg locally

```sh
docker compose up -d gotenberg
```

or directly:

```sh
docker run --rm -p 3010:3000 gotenberg/gotenberg:8
```

Gotenberg is stateless: no migrations, no shared state, scales
horizontally.

## Usage

```ts
import { gotenbergTools } from "@corbits/gotenberg";

const agent = defineAgent({
  // ...
  tools: [gotenbergTools],
});
```

## Running tests

```
cd tools/gotenberg && bun test
```
