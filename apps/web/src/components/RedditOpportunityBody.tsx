import type { ReactNode } from 'react';
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

export default function RedditOpportunityBody({ scan }: { scan: RedditOpportunityScan }) {
  const topOpportunities = scan.opportunities.slice(0, 8);
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
          Competitors: {scan.businessProfile.competitors.join(', ')}
        </p>
        {scan.businessProfile.audienceNotes && (
          <p className="text-xs text-text-3">Audience: {scan.businessProfile.audienceNotes}</p>
        )}
      </Section>

      <Section title="Recommendations">
        <p className="text-xs text-text-3">
          Keywords: {scan.recommendations.keywords.map((item) => item.label).join(', ')}
        </p>
        <p className="text-xs text-text-3">
          Subreddits: {scan.recommendations.subreddits.map((item) => item.label).join(', ')}
        </p>
      </Section>

      <Section title="Ranked opportunities">
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
                    r/{opportunity.subreddit} - score {opportunity.score}
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
            </article>
          ))}
        </div>
      </Section>

      <Section title="Watchlist and exports">
        <p className="text-xs text-text-3">Watchlist keywords: {scan.watchlist.keywords.join(', ')}</p>
        <p className="text-xs text-text-3">
          Watchlist subreddits: {scan.watchlist.subreddits.join(', ')}
        </p>
        <p className="text-xs text-text-3">Last scanned: {scan.watchlist.lastScannedAt}</p>
        <p className="text-xs text-text-3">Exports: channel brief, response playbook, opportunity feed</p>
      </Section>
    </div>
  );
}
