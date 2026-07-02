import { usesSocialPostPreview } from "@workbench/artifact";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Markdown } from "@workbench/ui";
import CompareBody from "./CompareBody";
import GammaPresentationBody from "./GammaPresentationBody";
import PresentationBody from "./PresentationBody";
import ResearchBody, { parseResearchBrief } from "./ResearchBody";
import { buildApiUrl } from "../lib/api";

interface ArtifactBodyArtifact {
  content: string;
  kind: string;
  source?: unknown;
  // Used by the interactive `selection` renderer (to PATCH the pick back) and
  // the `csv-export` download link; optional because most kinds don't need them.
  id?: string;
  sessionId?: string | null;
}

interface ArtifactBodyProps {
  artifact: ArtifactBodyArtifact;
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

function LinkedInBody({ body }: { body: string }) {
  return (
    <div className="bg-surface-2 rounded border border-border p-5">
      <div className="flex items-center gap-3 mb-4 pb-4 border-b border-border">
        <div className="w-10 h-10 rounded-full bg-surface border border-border flex items-center justify-center text-text-3 text-xs font-bold">
          YOU
        </div>
        <div>
          <div className="text-sm font-semibold text-text">Your Name</div>
          <div className="text-xs text-text-3">Your Title · 1st</div>
        </div>
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
function OnePagerBody({ body }: { body: string }) {
  return <Markdown className="max-w-[68ch]">{body}</Markdown>;
}

function CsvExportBody({
  body,
  artifactId,
}: {
  body: string;
  artifactId: string;
}) {
  // Same-origin download route; the session cookie authorizes it. A plain anchor
  // is sufficient — no JS fetch needed.
  return (
    <div className="space-y-3">
      <a
        href={buildApiUrl(`/artifacts/${artifactId}/download`)}
        download
        className="inline-block rounded bg-accent px-4 py-2 text-sm font-medium text-white"
      >
        Download CSV
      </a>
      <pre className="overflow-x-auto rounded border border-border bg-surface-2 p-3 text-xs text-text-2">
        {body}
      </pre>
    </div>
  );
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
        className="inline-block rounded bg-accent px-4 py-2 text-sm font-medium text-white"
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
      className="inline-block rounded bg-accent px-4 py-2 text-sm font-medium text-white"
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

export default function ArtifactBody({ artifact }: ArtifactBodyProps) {
  const body = artifact.content;
  const type = artifact.kind;
  const brief = extractBrief(artifact.source);
  const uploadFilename = extractUploadFilename(artifact.source);

  if (usesSocialPostPreview(type)) {
    return <LinkedInBody body={body} />;
  }

  switch (type) {
    // uploaded binaries (file/folder import) — served by the download route
    case "image": {
      if (!artifact.id) return <OnePagerBody body={body} />;
      return <ImageBody artifactId={artifact.id} filename={uploadFilename} />;
    }
    case "file": {
      if (!artifact.id) return <OnePagerBody body={body} />;
      return <FileBody artifactId={artifact.id} filename={uploadFilename} />;
    }
    // downloadable export
    case "csv-export": {
      if (!artifact.id) {
        return (
          <pre className="overflow-x-auto p-3 text-xs text-text-2">{body}</pre>
        );
      }
      return <CsvExportBody body={body} artifactId={artifact.id} />;
    }
    // single-file HTML app or landing page
    case "web":
      return <WebBody html={body} />;
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
      return <OnePagerBody body={body} />;
    // battlecard
    case "battlecard":
      return <OnePagerBody body={body} />;
    // A/B comparison — content is JSON.stringify(ComparisonResult)
    case "ab-comparison":
      return <CompareBody content={body} />;
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
          <p className="text-sm text-text-3 p-4">
            Presentation URL is invalid or unavailable.
          </p>
        );
      }
      return <PresentationBody url={body} />;
    }
    // gamma deck — content is JSON.stringify(GammaPresentationContent)
    case "gamma_presentation":
      return <GammaPresentationBody content={body} />;
    // research
    case "research": {
      const parsedBrief = parseResearchBrief(brief);
      if (parsedBrief !== null) {
        return <ResearchBody brief={parsedBrief} body={body} />;
      }
      return <OnePagerBody body={body} />;
    }
    // fallback
    default:
      return <OnePagerBody body={body} />;
  }
}
