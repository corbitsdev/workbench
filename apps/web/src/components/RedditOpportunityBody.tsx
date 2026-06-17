import { useMemo, useState, type ReactNode } from 'react';
import {
  parseRedditOpportunityScanArtifact,
  type RedditOpportunityScanArtifact,
} from '@workbench/gtm-workflows/reddit-opportunity-scanner';

export type RedditOpportunityScan = RedditOpportunityScanArtifact;

export function parseRedditOpportunityScan(value: unknown): RedditOpportunityScan | null {
  return parseRedditOpportunityScanArtifact(value);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 rounded border border-border bg-surface-2 p-4">
      <h2 className="text-sm font-semibold text-text">{title}</h2>
      {children}
    </section>
  );
}

export default function RedditOpportunityBody({
  scan,
  editableStatuses = false,
  onStatusChange,
}: {
  scan: RedditOpportunityScan;
  editableStatuses?: boolean;
  onStatusChange?: (opportunityId: string, status: string) => void;
}) {
  const [subredditFilter, setSubredditFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const subreddits = useMemo(
    () => [...new Set(scan.opportunities.map((o) => o.subreddit))],
    [scan.opportunities]
  );

  const filtered = useMemo(() => {
    return scan.opportunities.filter((opp) => {
      if (subredditFilter !== 'all' && opp.subreddit !== subredditFilter) return false;
      if (statusFilter !== 'all' && opp.status !== statusFilter) return false;
      return true;
    });
  }, [scan.opportunities, statusFilter, subredditFilter]);

  const topOpportunities = filtered.slice(0, 12);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-base font-semibold text-text">{scan.title}</h1>
        <p className="text-sm text-text-2">{scan.summary}</p>
        <p className="text-xs text-text-3 break-all">{scan.inputUrl}</p>
      </div>

      <Section title="Business profile">
        <p className="text-sm text-text-2">{scan.businessProfile.whatTheySell}</p>
        <p className="text-xs text-text-3">
          Keywords: {scan.businessProfile.mainKeywords.join(', ')}
        </p>
        <p className="text-xs text-text-3">
          Competitors: {scan.businessProfile.competitors.join(', ') || 'None identified'}
        </p>
        {scan.businessProfile.audienceNotes && (
          <p className="text-xs text-text-3">Audience: {scan.businessProfile.audienceNotes}</p>
        )}
      </Section>

      <Section title="Recommendations">
        <p className="text-xs text-text-3">
          Keywords:{' '}
          {scan.recommendations.keywords
            .filter((k) => k.source !== 'rejected')
            .map((item) => item.label)
            .join(', ')}
        </p>
        <p className="text-xs text-text-3">
          Subreddits:{' '}
          {scan.recommendations.subreddits
            .filter((s) => s.source !== 'rejected')
            .map((item) => `r/${item.label.replace(/^r\//i, '')}`)
            .join(', ')}
        </p>
      </Section>

      {scan.opportunities.length > 0 && (
        <Section title="Ranked opportunities">
          <div className="flex flex-wrap gap-2 pb-2">
            <select
              value={subredditFilter}
              onChange={(e) => setSubredditFilter(e.target.value)}
              className="rounded border border-border bg-surface px-2 py-1 text-xs text-text"
            >
              <option value="all">All subreddits</option>
              {subreddits.map((sub) => (
                <option key={sub} value={sub}>
                  r/{sub}
                </option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded border border-border bg-surface px-2 py-1 text-xs text-text"
            >
              <option value="all">All statuses</option>
              <option value="new">New</option>
              <option value="saved">Saved</option>
              <option value="dismissed">Dismissed</option>
              <option value="handled">Handled</option>
            </select>
          </div>
          <div className="space-y-3">
            {topOpportunities.map((opportunity) => (
              <article
                key={opportunity.id}
                className="rounded border border-border bg-surface p-3 space-y-1"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-text">{opportunity.postTitle}</p>
                    <p className="text-xs text-text-3">
                      r/{opportunity.subreddit} · score {opportunity.score} · {opportunity.status}
                    </p>
                  </div>
                  <a
                    className="text-xs text-accent hover:underline"
                    href={opportunity.permalink}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open Reddit
                  </a>
                </div>
                <p className="text-xs text-text-2">{opportunity.evidenceSnippet}</p>
                <p className="text-xs text-text-3">
                  Matched terms: {opportunity.matchedTerms.join(', ')}
                </p>
                <p className="text-xs text-text-3">Action: {opportunity.recommendedAction}</p>
                {editableStatuses && onStatusChange && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {(['saved', 'dismissed', 'handled', 'new'] as const).map((status) => (
                      <button
                        key={status}
                        type="button"
                        onClick={() => onStatusChange(opportunity.id, status)}
                        className="rounded border border-border px-2 py-0.5 text-[11px] text-text-2 hover:text-text"
                      >
                        {status}
                      </button>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        </Section>
      )}

      <Section title="Watchlist and exports">
        <p className="text-xs text-text-3">
          Watchlist keywords: {scan.watchlist.keywords.join(', ')}
        </p>
        <p className="text-xs text-text-3">
          Watchlist subreddits: {scan.watchlist.subreddits.join(', ')}
        </p>
        <p className="text-xs text-text-3">Last scanned: {scan.watchlist.lastScannedAt}</p>
        {scan.exports.channelBrief && (
          <p className="text-xs text-text-2 whitespace-pre-wrap">{scan.exports.channelBrief}</p>
        )}
      </Section>
    </div>
  );
}
