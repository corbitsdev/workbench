import { useEffect, useRef, useState } from "react";
import { type Report, parseReport } from "@workbench/last30days-core";
import { Markdown } from "@workbench/ui";

// The brief contract is owned by @workbench/last30days-core; the web validates
// the persisted artifact payload at the boundary via the package's parse helper
// rather than re-declaring the schema (which would drift from the source of truth).
export type ResearchBrief = Report;

export function parseResearchBrief(value: unknown): ResearchBrief | null {
  return parseReport(value);
}

const MONTH_DAY = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const MONTH_DAY_YEAR = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function formatDateRange(from: string, to: string): string {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return `${from}–${to}`;
  }
  return `${MONTH_DAY.format(fromDate)} – ${MONTH_DAY_YEAR.format(toDate)}`;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function StatsLine({ stats }: { stats: ResearchBrief["stats"] }) {
  return (
    <p className="font-mono text-[13px] text-text-3 tabular-nums">
      {formatCount(stats.sourceCount)} sources · {formatCount(stats.itemCount)}{" "}
      items
      {stats.dateRange
        ? ` · ${formatDateRange(stats.dateRange.from, stats.dateRange.to)}`
        : ""}
    </p>
  );
}

function ClusterSection({
  cluster,
}: {
  cluster: ResearchBrief["clusters"][number];
}) {
  const topItems = cluster.items.slice(0, 5);
  return (
    <div className="border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-text leading-snug">
          {cluster.title}
        </h3>
        {cluster.sources.length > 0 && (
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="rounded border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-text-3">
              {cluster.sources.join(", ")}
            </span>
          </div>
        )}
      </div>
      {cluster.summary && (
        <p className="text-xs text-text-2 leading-relaxed">{cluster.summary}</p>
      )}
      {topItems.length > 0 && (
        <ul className="space-y-1.5">
          {topItems.map((item) => (
            <li key={item.url} className="flex items-start gap-2">
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-text-2 hover:text-text hover:underline leading-snug flex-1 min-w-0 truncate"
              >
                {item.title}
              </a>
              <span className="font-mono text-[11px] text-text-3 shrink-0 whitespace-nowrap tabular-nums">
                {formatCount(item.engagement?.upvotes ?? 0)} up ·{" "}
                {formatCount(item.engagement?.comments ?? 0)} comments
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BestTakesSection({ takes }: { takes: ResearchBrief["bestTakes"] }) {
  if (takes.length === 0) return null;
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-text">Best Takes</h2>
      {takes.map((take, index) => (
        <div key={index} className="border-l-2 border-border pl-4 space-y-1">
          <p className="text-sm text-text-2 leading-relaxed italic">
            {take.quote}
          </p>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-text-3">
              {take.author ? `${take.author} · ` : ""}
              {take.source}
            </span>
            <span className="text-[11px] text-text-3 tabular-nums">
              {formatCount(take.engagement)} engagement
            </span>
            <a
              href={take.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-accent hover:underline"
            >
              source
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}

// A citation list can repeat a URL (an item that clustered across sources). Both
// the on-screen list and the exported ## Sources section show one entry per URL,
// so they never disagree on count or numbering.
function dedupeCitationsByUrl(
  citations: ResearchBrief["citations"],
): ResearchBrief["citations"] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    if (seen.has(citation.url)) return false;
    seen.add(citation.url);
    return true;
  });
}

function CitationsSection({
  citations,
}: {
  citations: ResearchBrief["citations"];
}) {
  const deduped = dedupeCitationsByUrl(citations);
  if (deduped.length === 0) return null;
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-text">Citations</h2>
      <ol className="space-y-2.5">
        {deduped.map((citation, index) => (
          <li key={index} className="flex items-baseline gap-3 text-[13px]">
            <span className="font-mono text-xs text-text-3 tabular-nums shrink-0 w-6 text-right">
              {index + 1}
            </span>
            <span className="min-w-0 leading-relaxed">
              <a
                href={citation.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline break-words"
              >
                {citation.title ?? citation.url}
              </a>
              <span className="text-text-3"> · {citation.source}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "research-report"
  );
}

export function buildSourcesSection(brief: ResearchBrief): string {
  const citations = dedupeCitationsByUrl(brief.citations);
  if (citations.length === 0) return "";
  const lines = citations.map(
    (citation, index) =>
      `${index + 1}. [${citation.title ?? citation.url}](${citation.url}) — ${citation.source}`,
  );
  return `\n\n## Sources\n\n${lines.join("\n")}`;
}

function ReportActions({
  markdown,
  brief,
}: {
  markdown: string;
  brief: ResearchBrief;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  const fullMarkdown = markdown + buildSourcesSection(brief);

  const copy = () => {
    navigator.clipboard
      .writeText(fullMarkdown)
      .then(() => {
        setCopied(true);
        if (resetTimer.current) clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopied(false));
  };

  const download = () => {
    const blob = new Blob([fullMarkdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${slugify(brief.topic)}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const buttonBase =
    "inline-flex items-center justify-center min-h-10 rounded-md px-4 py-2 text-[13px] font-medium transition-transform active:scale-[0.97]";

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={copy}
        className={`${buttonBase} border border-border bg-surface-2 text-text-2 hover:text-text`}
      >
        {copied ? "Copied" : "Copy markdown"}
      </button>
      <button
        type="button"
        onClick={download}
        className={`${buttonBase} bg-accent text-charcoal hover:bg-accent-deep`}
      >
        Download .md
      </button>
    </div>
  );
}

function ResearchData({ brief }: { brief: ResearchBrief }) {
  return (
    <div className="space-y-6">
      {brief.clusters.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-text">Top Clusters</h2>
          {brief.clusters.map((cluster) => (
            <ClusterSection key={cluster.id} cluster={cluster} />
          ))}
        </div>
      )}

      <BestTakesSection takes={brief.bestTakes} />

      <CitationsSection citations={brief.citations} />
    </div>
  );
}

interface ResearchBodyProps {
  brief: ResearchBrief;
  // The prose report markdown persisted alongside the structured brief. When
  // present it is the primary deliverable; the brief becomes supporting data.
  body?: string;
  layout?: "inline" | "detail";
}

export default function ResearchBody({
  brief,
  body,
  layout = "inline",
}: ResearchBodyProps) {
  const proseClass = layout === "detail" ? "max-w-none w-full" : "max-w-[68ch]";
  const report = body?.trim() ?? "";

  // No prose report persisted (older artifacts): fall back to the structured view.
  if (report === "") {
    return (
      <div className="space-y-6">
        <div className="space-y-1.5">
          <h1 className="text-base font-semibold text-text leading-snug">
            {brief.topic}
          </h1>
          <StatsLine stats={brief.stats} />
          {brief.leadInsight && (
            <p className="text-sm text-text-2 leading-relaxed">
              {brief.leadInsight}
            </p>
          )}
        </div>
        <ResearchData brief={brief} />
      </div>
    );
  }

  return (
    <div className="space-y-7">
      <div className="flex items-start justify-between gap-4 pb-5 border-b border-border">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-text leading-tight text-balance">
            {brief.topic}
          </h1>
          <StatsLine stats={brief.stats} />
        </div>
        <ReportActions markdown={report} brief={brief} />
      </div>

      <Markdown className={proseClass}>{report}</Markdown>

      <details className="group border-t border-border pt-4">
        <summary className="flex items-center gap-2 cursor-pointer list-none text-sm font-semibold text-text-2 hover:text-text [&::-webkit-details-marker]:hidden">
          <svg
            className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M6 4l4 4-4 4" />
          </svg>
          <span>
            Sources &amp; data ({brief.stats.sourceCount} sources ·{" "}
            {brief.stats.itemCount} items)
          </span>
        </summary>
        <div className="mt-5">
          <ResearchData brief={brief} />
        </div>
      </details>
    </div>
  );
}
