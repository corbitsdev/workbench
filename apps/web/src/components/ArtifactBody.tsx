import { usesSocialPostPreview } from "@workbench/artifact";
import { Markdown } from "@workbench/ui";
import CompareBody from "./CompareBody";
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
