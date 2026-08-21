// Talks to one Gotenberg server (https://gotenberg.dev) over its Chromium
// module's Markdown route: POST an `index.html` that inlines a Markdown
// file via Gotenberg's `toHTML` template helper, get a rendered PDF back.
// Gotenberg is stateless and holds no workbench data of its own — every
// call is a one-shot conversion, nothing to provision or migrate.
export type GotenbergFetch = typeof fetch;

const MARKDOWN_ROUTE = "/forms/chromium/convert/markdown";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function indexTemplateFor(title: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<title>${escapeHtml(title)}</title></head>` +
    `<body>{{ toHTML "body.md" }}</body></html>`
  );
}

export class GotenbergRenderError extends Error {}

/**
 * Converts one Markdown document to PDF bytes via a Gotenberg server.
 * Throws `GotenbergRenderError` on any transport or non-2xx failure —
 * callers report it through `@corbits/error-sink`, never swallow it.
 */
export async function renderMarkdownToPdf(
  config: { readonly baseUrl: string },
  input: { readonly title: string; readonly markdown: string },
  fetchImpl: GotenbergFetch = fetch,
): Promise<Uint8Array> {
  const form = new FormData();
  form.append(
    "files",
    new Blob([indexTemplateFor(input.title)], { type: "text/html" }),
    "index.html",
  );
  form.append(
    "files",
    new Blob([input.markdown], { type: "text/markdown" }),
    "body.md",
  );

  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}${MARKDOWN_ROUTE}`, {
      method: "POST",
      body: form,
    });
  } catch (err) {
    throw new GotenbergRenderError(
      `Could not reach Gotenberg at ${config.baseUrl}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!response.ok) {
    throw new GotenbergRenderError(
      `Gotenberg rejected the render: ${response.status} ${response.statusText}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}
