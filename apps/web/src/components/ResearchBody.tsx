import { type Report, parseReport } from "@workbench/last30days-core";

// The brief contract is owned by @workbench/last30days-core; the web validates
// the persisted artifact payload at the boundary via the package's parse helper
// rather than re-declaring the schema (which would drift from the source of truth).
export type ResearchBrief = Report;

export function parseResearchBrief(value: unknown): ResearchBrief | null {
  return parseReport(value);
}

function StatsLine({ stats }: { stats: ResearchBrief["stats"] }) {
  return (
    <p className="text-sm text-text-3">
      {stats.sourceCount} sources · {stats.itemCount} items
      {stats.dateRange
        ? ` · ${stats.dateRange.from}–${stats.dateRange.to}`
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
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="rounded border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-text-3">
            score {cluster.score.toFixed(1)}
          </span>
          {cluster.sources.length > 0 && (
            <span className="rounded border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-text-3">
              {cluster.sources.join(", ")}
            </span>
          )}
        </div>
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
              <span className="text-[11px] text-text-3 shrink-0 whitespace-nowrap">
                {item.engagement?.upvotes ?? 0} up ·{" "}
                {item.engagement?.comments ?? 0} comments
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
            <span className="text-[11px] text-text-3">
              {take.engagement} engagement
            </span>
            <a
              href={take.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-text-3 hover:text-text hover:underline"
            >
              source
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}

function CitationsSection({
  citations,
}: {
  citations: ResearchBrief["citations"];
}) {
  if (citations.length === 0) return null;
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold text-text">Citations</h2>
      <ol className="space-y-1">
        {citations.map((citation, index) => (
          <li
            key={index}
            className="flex items-start gap-2 text-[11px] text-text-3"
          >
            <span className="shrink-0">{index + 1}.</span>
            <span className="min-w-0">
              {citation.title && (
                <span className="text-text-2">{citation.title} — </span>
              )}
              <a
                href={citation.url}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-text hover:underline break-all"
              >
                {citation.source}
              </a>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

interface ResearchBodyProps {
  brief: ResearchBrief;
}

export default function ResearchBody({ brief }: ResearchBodyProps) {
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
