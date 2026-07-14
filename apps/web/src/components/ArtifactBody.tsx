import { usesSocialPostPreview } from "@workbench/artifact";
import {
  buildWebSitePreviewHtml,
  parseWebSiteContentJson,
  WebSiteContentError,
} from "@workbench/shared";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { FileWarning, Link2Off, User } from "lucide-react";
import { buttonVariants, Markdown } from "@workbench/ui";
import CompareBody from "./CompareBody";
import { CsvTable, CsvTooLarge } from "./CsvTable";
import GammaPresentationBody from "./GammaPresentationBody";
import PresentationBody from "./PresentationBody";
import ResearchBody, { parseResearchBrief } from "./ResearchBody";
import { buildApiUrl } from "../lib/api";
import { useArtifactCsvPreview } from "../hooks/use-artifact-csv-preview";

interface ArtifactBodyArtifact {
  content: string;
  kind: string;
  source?: unknown;
  // Used by the interactive `selection` renderer (to PATCH the pick back) and
  // the `csv-export` download link; optional because most kinds don't need it.
  id?: string;
  // The real name of the artifact's owner, when known — used to give the
  // LinkedIn preview a genuine identity instead of fabricated chrome text.
  ownerName?: string | null;
}

// Shared "designed" fallback for weak/unparseable previews (invalid URL,
// missing id, malformed payload): an icon + message inside the same muted
// card treatment used elsewhere in this file, never a raw `<pre>` dump or a
// bare sentence.
function PreviewFallback({
  icon: Icon = FileWarning,
  message,
  action,
}: {
  icon?: typeof FileWarning;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded border border-border bg-surface-2/40 px-6 py-10 text-center">
      <Icon className="h-8 w-8 text-text-3" aria-hidden="true" />
      <p className="max-w-[42ch] text-sm text-text-3">{message}</p>
      {action}
    </div>
  );
}

interface ArtifactBodyProps {
  artifact: ArtifactBodyArtifact;
  /** `detail` uses full-width stage layouts (artifact detail page / modal). */
  layout?: "inline" | "detail";
}

function proseClass(layout: "inline" | "detail"): string {
  return layout === "detail" ? "max-w-none w-full" : "max-w-[68ch]";
}

// The structured brief lives at source.brief; source is an opaque jsonb bag, so
// pull the brief out defensively rather than asserting its shape here.
function extractBrief(source: unknown): unknown {
  if (typeof source === "object" && source !== null && "brief" in source) {
    return (source as Record<string, unknown>).brief;
  }
  return undefined;
}

function EmailBody({ body }: { body: string }) {
  return (
    <div className="font-mono text-sm text-text-2 leading-relaxed whitespace-pre-wrap bg-surface-2 rounded border border-border p-5">
      {body}
    </div>
  );
}

// Two initials from a real name (e.g. "Jane Doe" -> "JD"); a single-word name
// yields its first letter only.
function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

function LinkedInBody({
  body,
  authorName,
}: {
  body: string;
  authorName?: string | null;
}) {
  return (
    <div className="bg-surface-2 rounded border border-border p-5">
      <div className="flex items-center gap-3 mb-4 pb-4 border-b border-border">
        <div className="w-10 h-10 rounded-full bg-surface border border-border flex items-center justify-center text-text-3 text-xs font-bold">
          {authorName ? (
            initialsFromName(authorName)
          ) : (
            <User className="h-5 w-5" aria-hidden="true" />
          )}
        </div>
        {authorName && (
          <div className="text-sm font-semibold text-text">{authorName}</div>
        )}
      </div>
      <p className="text-sm text-text-2 leading-relaxed whitespace-pre-wrap">
        {body}
      </p>
    </div>
  );
}

// One shared prose surface for every document-kind artifact. GFM tables, lists,
// headings, code, and citations are all handled by the shared <Markdown> path —
// the artifact body no longer forks on whether the content "looks like a table".
function OnePagerBody({
  body,
  layout = "inline",
}: {
  body: string;
  layout?: "inline" | "detail";
}) {
  return <Markdown className={proseClass(layout)}>{body}</Markdown>;
}

function DownloadCsvLink({ artifactId }: { artifactId: string }) {
  // Same-origin download route; the session cookie authorizes it. A plain anchor
  // is sufficient — no JS fetch needed. Styled with the shared Button variants
  // so it reads as the same primitive as every other action in the app.
  return (
    <a
      href={buildApiUrl(`/artifacts/${artifactId}/download`)}
      download
      className={buttonVariants({ variant: "secondary", size: "sm" })}
    >
      Download CSV
    </a>
  );
}

function CsvExportBody({
  body,
  artifactId,
}: {
  body: string;
  artifactId: string;
}) {
  // csv-export stores its CSV inline in `artifact.content` — no fetch needed;
  // parse and render it as a table with the download link alongside.
  return (
    <div className="space-y-3">
      <DownloadCsvLink artifactId={artifactId} />
      <CsvTable csvText={body} />
    </div>
  );
}

// Uploaded `.csv` files carry kind `file` with empty `content`; their bytes live
// in the upload table. Fetch the text from the download route, then render the
// same CSV table. A fetch failure degrades to the plain download link so the
// file is always retrievable even if the inline preview can't load.
function UploadedCsvBody({
  artifactId,
  filename,
}: {
  artifactId: string;
  filename: string | null;
}) {
  const { data, isLoading, isError } = useArtifactCsvPreview(artifactId);

  if (isLoading) {
    return (
      <div className="rounded border border-border bg-surface-2/40 px-4 py-8 text-center text-sm text-text-3">
        Loading CSV…
      </div>
    );
  }

  // A failed fetch: keep the file retrievable and say why the table is absent in
  // plain language rather than silently dropping to a bare download link.
  if (isError || data === undefined) {
    return (
      <div className="space-y-3">
        <FileBody artifactId={artifactId} filename={filename} />
        <p className="text-sm text-text-3">
          Preview unavailable — download to view.
        </p>
      </div>
    );
  }

  if (data.kind === "too-large") {
    return (
      <div className="space-y-3">
        <DownloadCsvLink artifactId={artifactId} />
        <CsvTooLarge />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <DownloadCsvLink artifactId={artifactId} />
      <CsvTable csvText={data.text} />
    </div>
  );
}

// Uploaded CSVs are detected at render (no upload-time kind change, no
// migration): the client-supplied mime is a routing hint and the `.csv`
// extension is a secondary signal for browsers that send a vendor mime or none.
// The parser, not this check, is the real gate — a mis-routed non-CSV degrades
// to raw text.
function isCsvUpload(source: unknown, filename: string | null): boolean {
  if (typeof source === "object" && source !== null) {
    const upload = (source as Record<string, unknown>).upload;
    if (typeof upload === "object" && upload !== null) {
      const mimeType = (upload as Record<string, unknown>).mimeType;
      if (mimeType === "text/csv") return true;
    }
  }
  return filename !== null && filename.toLowerCase().endsWith(".csv");
}

function extractUploadFilename(source: unknown): string | null {
  if (typeof source !== "object" || source === null) return null;
  const upload = (source as Record<string, unknown>).upload;
  if (typeof upload !== "object" || upload === null) return null;
  const filename = (upload as Record<string, unknown>).filename;
  return typeof filename === "string" && filename.length > 0 ? filename : null;
}

function ImageBody({
  artifactId,
  filename,
}: {
  artifactId: string;
  filename: string | null;
}) {
  const src = buildApiUrl(`/artifacts/${artifactId}/download`);
  return (
    <div className="space-y-3">
      <img
        src={src}
        alt={filename ?? "Uploaded image"}
        className="max-h-[480px] max-w-full rounded border border-border"
      />
      <a
        href={src}
        download
        className={buttonVariants({ variant: "secondary", size: "sm" })}
      >
        Download {filename ?? "image"}
      </a>
    </div>
  );
}

function FileBody({
  artifactId,
  filename,
}: {
  artifactId: string;
  filename: string | null;
}) {
  return (
    <a
      href={buildApiUrl(`/artifacts/${artifactId}/download`)}
      download
      className={buttonVariants({ variant: "secondary", size: "sm" })}
    >
      Download {filename ?? "file"}
    </a>
  );
}

// Untrusted, model-generated HTML: render in a null-origin sandbox (no
// `allow-same-origin`, so it can't reach the app's cookies/storage/DOM). Only
// `allow-scripts` is granted — `allow-popups`/`allow-forms` are withheld so the
// content can't open phishing tabs or POST to exfiltrate; a static preview
// needs neither.
const WEB_ARTIFACT_SANDBOX = "allow-scripts";
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

function WebFrame({ html }: { html: string }) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => setLoaded(false), [html]);
  return (
    <div className="relative h-full w-full">
      <iframe
        srcDoc={html}
        title="Web artifact preview"
        sandbox={WEB_ARTIFACT_SANDBOX}
        onLoad={() => setLoaded(true)}
        className="h-full w-full border-0 bg-white"
      />
      {loaded ? null : (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-surface text-sm text-text-3">
          Loading preview…
        </div>
      )}
    </div>
  );
}

function WebBody({ html }: { html: string }) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Lock background scroll and restore focus to the trigger on close, so the
  // `aria-modal` contract the dialog advertises is actually enforced.
  useEffect(() => {
    if (!isFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const trigger = triggerRef.current;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setIsFullscreen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      trigger?.focus();
    };
  }, [isFullscreen]);

  // Move focus into the dialog when it opens (synchronously, pre-paint).
  useLayoutEffect(() => {
    if (!isFullscreen || !dialogRef.current) return;
    const items = dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
    (items[0] ?? dialogRef.current).focus();
  }, [isFullscreen]);

  function trapTab(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab" || !dialogRef.current) return;
    const items = dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (html.trim().length === 0) {
    return (
      <div className="rounded border border-border bg-surface-2/40 px-4 py-8 text-center text-sm text-text-3">
        This web artifact has no content to preview yet.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded border border-border bg-surface">
        <div className="h-[60vh] max-h-[640px] min-h-[360px] w-full">
          <WebFrame html={html} />
        </div>
      </div>
      <div className="text-right">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setIsFullscreen(true)}
          className="rounded border border-border px-3 py-1.5 text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text active:scale-[0.98]"
        >
          Open full screen &rarr;
        </button>
      </div>
      {isFullscreen ? (
        <div
          ref={dialogRef}
          onKeyDown={trapTab}
          tabIndex={-1}
          className="fixed inset-0 z-50 flex flex-col bg-surface"
          role="dialog"
          aria-modal="true"
          aria-label="Web artifact full screen preview"
        >
          <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-3">
            <span className="text-sm font-medium text-text">Web preview</span>
            <button
              type="button"
              onClick={() => setIsFullscreen(false)}
              className="rounded border border-border px-3 py-1.5 text-sm text-text-2 transition-colors hover:bg-surface-2 hover:text-text active:scale-[0.98]"
            >
              Close
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <WebFrame html={html} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function WebSiteBody({ content }: { content: string }) {
  let entry = "index.html";
  let previewHtml = "";
  let paths: string[] = [];
  try {
    const site = parseWebSiteContentJson(content);
    entry = site.entry ?? "index.html";
    previewHtml = buildWebSitePreviewHtml(site);
    paths = Object.keys(site.files).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    const message =
      error instanceof WebSiteContentError
        ? error.message
        : "Invalid web_site artifact content";
    return (
      <div className="rounded border border-border bg-surface-2/40 px-4 py-8 text-center text-sm text-text-3">
        {message}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <WebBody html={previewHtml} />
      <div className="rounded border border-border bg-surface-2/30 px-4 py-3 text-sm text-text-2">
        <p className="font-medium text-text">Site bundle</p>
        <p className="mt-1 text-text-3">
          Entry: <span className="font-mono text-text-2">{entry}</span> ·{" "}
          {paths.length} file{paths.length === 1 ? "" : "s"}
        </p>
        <ul className="mt-2 max-h-40 list-inside list-disc overflow-y-auto font-mono text-xs text-text-3">
          {paths.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function ArtifactBody({
  artifact,
  layout = "inline",
}: ArtifactBodyProps) {
  const body = artifact.content;
  const type = artifact.kind;
  const brief = extractBrief(artifact.source);
  const uploadFilename = extractUploadFilename(artifact.source);

  if (usesSocialPostPreview(type)) {
    return <LinkedInBody body={body} authorName={artifact.ownerName} />;
  }

  switch (type) {
    // uploaded binaries (file/folder import) — served by the download route
    case "image": {
      if (!artifact.id) return <OnePagerBody body={body} layout={layout} />;
      return <ImageBody artifactId={artifact.id} filename={uploadFilename} />;
    }
    case "file": {
      if (!artifact.id) return <OnePagerBody body={body} layout={layout} />;
      if (isCsvUpload(artifact.source, uploadFilename)) {
        return (
          <UploadedCsvBody artifactId={artifact.id} filename={uploadFilename} />
        );
      }
      return <FileBody artifactId={artifact.id} filename={uploadFilename} />;
    }
    // downloadable export
    case "csv-export": {
      if (!artifact.id) {
        return (
          <PreviewFallback message="This CSV export can't be identified — no artifact id was found, so it can't be previewed or downloaded." />
        );
      }
      return <CsvExportBody body={body} artifactId={artifact.id} />;
    }
    // single-file HTML app or landing page
    case "web":
      return <WebBody html={body} />;
    case "web_site":
      return <WebSiteBody content={body} />;
    // email
    case "email":
    case "follow-up-email":
      return <EmailBody body={body} />;
    // documents
    case "one-pager":
    case "sales-one-pager":
    case "blog":
    case "pain-points-blog":
    case "case-study":
    case "case-study-draft":
    case "objection-handling":
    case "objection-handling-doc":
    case "customer-quotes":
    case "customer-quote-pulls":
    case "pain-points":
    case "call-transcript":
      return <OnePagerBody body={body} layout={layout} />;
    // battlecard
    case "battlecard":
      return <OnePagerBody body={body} layout={layout} />;
    // A/B comparison — content is JSON.stringify(ComparisonResult)
    case "ab-comparison":
      return <CompareBody content={body} layout={layout} />;
    // presentation
    case "presentation": {
      let isValidUrl = false;
      try {
        const parsed = new URL(body);
        isValidUrl = parsed.protocol === "https:";
      } catch {
        isValidUrl = false;
      }
      if (!isValidUrl) {
        return (
          <PreviewFallback
            icon={Link2Off}
            message="Presentation link is invalid or unavailable."
          />
        );
      }
      return <PresentationBody url={body} />;
    }
    // gamma deck — content is JSON.stringify(GammaPresentationContent); a
    // durable export PDF (source.upload) is offered via the download route.
    case "gamma_presentation":
      return (
        <GammaPresentationBody
          content={body}
          artifactId={artifact.id}
          hasPdf={uploadFilename !== null}
        />
      );
    // research
    case "research": {
      const parsedBrief = parseResearchBrief(brief);
      if (parsedBrief !== null) {
        return <ResearchBody brief={parsedBrief} body={body} layout={layout} />;
      }
      if (body.trim().length === 0) {
        return (
          <PreviewFallback message="This research artifact has no readable content — the underlying data couldn't be parsed." />
        );
      }
      return <OnePagerBody body={body} layout={layout} />;
    }
    // fallback
    default:
      return <OnePagerBody body={body} layout={layout} />;
  }
}
