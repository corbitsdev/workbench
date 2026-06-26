import { usesSocialPostPreview } from "@workbench/artifact";
import PresentationBody from "./PresentationBody";
import ResearchBody, { parseResearchBrief } from "./ResearchBody";
import { MarkdownBlock } from "./Markdown";
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

function parseMarkdownTable(
  text: string,
): { headers: string[]; rows: string[][] } | null {
  const lines = text.trim().split("\n");
  const tableLines = lines.filter((l) => l.trim().startsWith("|"));
  if (tableLines.length < 2) return null;

  const parseRow = (line: string) =>
    line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());

  const headers = parseRow(tableLines[0]);
  const rows = tableLines
    .slice(2)
    .filter((l) => !l.match(/^[\s|:-]+$/))
    .map(parseRow);

  return { headers, rows };
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

function OnePagerBody({ body }: { body: string }) {
  const tableData = parseMarkdownTable(body);
  if (tableData) {
    return <TableBody headers={tableData.headers} rows={tableData.rows} />;
  }
  return (
    <div className="prose prose-sm max-w-none">
      <MarkdownBlock text={body} />
    </div>
  );
}

function TableBody({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-surface-2 border-b border-border-strong">
            {headers.map((h, i) => (
              <th
                key={i}
                className="text-left px-4 py-2 text-xs font-semibold text-text-3 uppercase tracking-wide"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-border hover:bg-surface-2">
              {row.map((cell, j) => (
                <td key={j} className="px-4 py-3 text-text-2 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BattlecardBody({ body }: { body: string }) {
  const tableData = parseMarkdownTable(body);
  if (tableData) {
    return <TableBody headers={tableData.headers} rows={tableData.rows} />;
  }
  return <p className="text-sm text-text-2 whitespace-pre-wrap">{body}</p>;
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

export default function ArtifactBody({ artifact }: ArtifactBodyProps) {
  const body = artifact.content;
  const type = artifact.kind;
  const brief = extractBrief(artifact.source);

  if (usesSocialPostPreview(type)) {
    return <LinkedInBody body={body} />;
  }

  switch (type) {
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
      return <BattlecardBody body={body} />;
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
