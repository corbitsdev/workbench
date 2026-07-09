import { type } from "arktype";

export const WEB_SITE_KIND = "web_site" as const;
export const WEB_ARTIFACT_KIND = "web" as const;

export const WEB_SITE_MAX_FILE_BYTES = 4_500_000;
export const WEB_SITE_MAX_FILES = 64;
export const WEB_SITE_MAX_TOTAL_BYTES = 4_500_000;

export const WebSiteContentSchema = type({
  "entry?": "string",
  files: "Record<string, string>",
});

export type WebSiteContent = typeof WebSiteContentSchema.infer;

export class WebSiteContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSiteContentError";
  }
}

export function normalizeWebSitePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    throw new WebSiteContentError("file path must not be empty");
  }
  const normalized = trimmed.replace(/^\/+/, "").replace(/\\/g, "/");
  if (normalized.length === 0) {
    throw new WebSiteContentError("file path must not be empty");
  }
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment === "..") {
      throw new WebSiteContentError(`invalid path (traversal): ${path}`);
    }
    if (segment.length === 0) {
      throw new WebSiteContentError(`invalid path (empty segment): ${path}`);
    }
  }
  return normalized;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function assertWebSiteContentWithinLimits(
  content: WebSiteContent,
): void {
  const paths = Object.keys(content.files);
  if (paths.length === 0) {
    throw new WebSiteContentError("web_site must include at least one file");
  }
  if (paths.length > WEB_SITE_MAX_FILES) {
    throw new WebSiteContentError(
      `web_site exceeds max file count (${WEB_SITE_MAX_FILES})`,
    );
  }

  let total = 0;
  const normalizedKeys = new Set<string>();
  for (const rawPath of paths) {
    const path = normalizeWebSitePath(rawPath);
    if (normalizedKeys.has(path)) {
      throw new WebSiteContentError(
        `duplicate path after normalization: ${path}`,
      );
    }
    normalizedKeys.add(path);
    const fileContent = content.files[rawPath];
    if (typeof fileContent !== "string") {
      throw new WebSiteContentError(`file content must be a string: ${path}`);
    }
    const size = byteLength(fileContent);
    if (size > WEB_SITE_MAX_FILE_BYTES) {
      throw new WebSiteContentError(
        `file ${path} exceeds max size (${WEB_SITE_MAX_FILE_BYTES} bytes)`,
      );
    }
    total += size;
    if (total > WEB_SITE_MAX_TOTAL_BYTES) {
      throw new WebSiteContentError(
        `web_site total size exceeds ${WEB_SITE_MAX_TOTAL_BYTES} bytes`,
      );
    }
  }

  const entry = content.entry ?? "index.html";
  const entryPath = normalizeWebSitePath(entry);
  if (!normalizedKeys.has(entryPath)) {
    throw new WebSiteContentError(
      `entry file "${entryPath}" is not present in files`,
    );
  }
}

export function normalizeWebSiteContent(
  content: WebSiteContent,
): WebSiteContent {
  const files: Record<string, string> = {};
  for (const [rawPath, fileContent] of Object.entries(content.files)) {
    const path = normalizeWebSitePath(rawPath);
    files[path] = fileContent;
  }
  const entry =
    content.entry === undefined
      ? "index.html"
      : normalizeWebSitePath(content.entry);
  return { entry, files };
}

export function parseWebSiteContentJson(raw: string): WebSiteContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WebSiteContentError("web_site content must be valid JSON");
  }
  const result = WebSiteContentSchema(parsed);
  if (result instanceof type.errors) {
    throw new WebSiteContentError(
      `web_site content invalid: ${result.summary}`,
    );
  }
  const normalized = normalizeWebSiteContent(result);
  assertWebSiteContentWithinLimits(normalized);
  return normalized;
}

export function serializeWebSiteContent(content: WebSiteContent): string {
  const normalized = normalizeWebSiteContent(content);
  assertWebSiteContentWithinLimits(normalized);
  return JSON.stringify(normalized);
}

export type WebSiteReadSummary = {
  kind: typeof WEB_SITE_KIND;
  entry: string;
  files: { path: string; bytes: number }[];
  totalBytes: number;
};

export function summarizeWebSiteContent(rawJson: string): WebSiteReadSummary {
  const content = parseWebSiteContentJson(rawJson);
  const files = Object.entries(content.files)
    .map(([path, text]) => ({ path, bytes: byteLength(text) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  return {
    kind: WEB_SITE_KIND,
    entry: content.entry ?? "index.html",
    files,
    totalBytes,
  };
}

export type VercelDeployFile = { path: string; content: string };

function mimeTypeForSitePath(path: string): string {
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".html") || path.endsWith(".htm")) return "text/html";
  return "text/plain";
}

function dataUrlForSiteFile(path: string, fileContent: string): string {
  const mime = mimeTypeForSitePath(path);
  return `data:${mime};charset=utf-8,${encodeURIComponent(fileContent)}`;
}

function inlineSiteAssetRefs(html: string, path: string, dataUrl: string): string {
  const refs = [path, `./${path}`];
  let next = html;
  for (const ref of refs) {
    next = next.replaceAll(`href="${ref}"`, `href="${dataUrl}"`);
    next = next.replaceAll(`href='${ref}'`, `href='${dataUrl}'`);
    next = next.replaceAll(`src="${ref}"`, `src="${dataUrl}"`);
    next = next.replaceAll(`src='${ref}'`, `src='${dataUrl}'`);
  }
  return next;
}

/** Entry-page HTML with same-bundle link/script src/href inlined for sandboxed srcDoc preview. */
export function buildWebSitePreviewHtml(content: WebSiteContent): string {
  const normalized = normalizeWebSiteContent(content);
  const entry = normalized.entry ?? "index.html";
  const entryHtml = normalized.files[entry];
  if (entryHtml === undefined) {
    throw new WebSiteContentError(
      `entry file "${entry}" is not present in files`,
    );
  }
  let html = entryHtml;
  for (const [path, fileContent] of Object.entries(normalized.files)) {
    if (path === entry) continue;
    html = inlineSiteAssetRefs(
      html,
      path,
      dataUrlForSiteFile(path, fileContent),
    );
  }
  return html;
}

export function expandWebArtifactToVercelFiles(
  kind: string,
  rawContent: string,
): VercelDeployFile[] {
  if (kind === WEB_ARTIFACT_KIND) {
    if (rawContent.trim().length === 0) {
      throw new WebSiteContentError("web artifact content is empty");
    }
    const size = byteLength(rawContent);
    if (size > WEB_SITE_MAX_FILE_BYTES) {
      throw new WebSiteContentError(
        `web artifact exceeds max size (${WEB_SITE_MAX_FILE_BYTES} bytes)`,
      );
    }
    return [{ path: "index.html", content: rawContent }];
  }
  if (kind === WEB_SITE_KIND) {
    const site = parseWebSiteContentJson(rawContent);
    return Object.entries(site.files).map(([path, content]) => ({
      path,
      content,
    }));
  }
  throw new WebSiteContentError(
    `artifact kind "${kind}" cannot be deployed to Vercel (use web or web_site)`,
  );
}
