import type { NormalizedRedditPost, RedditScanContext } from './types';
import type { RedditOpportunityScanArtifact } from './schema';

export type ScoredOpportunity = RedditOpportunityScanArtifact['opportunities'][number];

function normalizeSubredditLabel(label: string): string {
  return label.replace(/^r\//i, '').trim();
}

function daysSince(isoDate: string): number {
  const ms = Date.now() - new Date(isoDate).getTime();
  return Math.max(0, ms / (1000 * 60 * 60 * 24));
}

export function collectSearchTerms(context: RedditScanContext): string[] {
  const keywords = context.recommendations.keywords
    .filter((item) => item.source !== 'rejected')
    .map((item) => item.label.trim())
    .filter((label) => label.length > 0);
  const competitors = context.businessProfile.competitors
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  const main = context.businessProfile.mainKeywords
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  if (context.scanConfig.matchMode === 'competitor') {
    return [...new Set([...competitors, ...main])];
  }
  if (context.scanConfig.matchMode === 'keyword') {
    return [...new Set([...keywords, ...main])];
  }
  return [...new Set([...keywords, ...competitors, ...main])];
}

export function scoreOpportunity(
  post: NormalizedRedditPost,
  context: RedditScanContext,
  matchedTerms: string[]
): ScoredOpportunity {
  const recencyDays = daysSince(post.publishedAt);
  const recency = recencyDays <= 7 ? 25 : recencyDays <= 30 ? 18 : recencyDays <= 90 ? 10 : 4;

  const upvotes = post.engagement.upvotes;
  const comments = post.engagement.comments;
  const engagement = Math.min(
    25,
    Math.round(Math.log10(upvotes + 1) * 8 + Math.log10(comments + 1) * 6)
  );

  const termMatch = Math.min(30, matchedTerms.length * 10);
  const intent = matchedTerms.some((t) =>
    ['recommend', 'looking for', 'alternative', 'help', 'advice', 'best'].some(
      (signal) => post.title.toLowerCase().includes(signal) || t.toLowerCase().includes('tool')
    )
  )
    ? 20
    : 10;

  const approvedSubreddits = context.recommendations.subreddits
    .filter((s) => s.source !== 'rejected')
    .map((s) => normalizeSubredditLabel(s.label).toLowerCase());
  const postSub = normalizeSubredditLabel(post.author.replace(/^r\//i, '')).toLowerCase();
  const subredditFit = approvedSubreddits.includes(postSub) ? 15 : 6;

  const score = Math.min(100, recency + engagement + termMatch + intent + subredditFit);

  const evidenceSnippet =
    post.topComments && post.topComments.length > 0
      ? (post.topComments[0] ?? post.title)
      : post.title;

  let recommendedAction = 'Monitor the thread and add context if the question is still open.';
  if (intent >= 20) {
    recommendedAction = 'Reply with a helpful benchmark or checklist — avoid a hard pitch.';
  }
  if (
    matchedTerms.some((t) =>
      context.businessProfile.competitors.map((c) => c.toLowerCase()).includes(t.toLowerCase())
    )
  ) {
    recommendedAction =
      'Compare honestly against the mentioned competitor and highlight differentiation.';
  }

  const subreddit = normalizeSubredditLabel(post.author.replace(/^r\//i, ''));

  const urlSlug = post.url.replace(/[^a-zA-Z0-9]+/g, '-').slice(-24);

  return {
    id: `opp-${urlSlug}`,
    subreddit,
    postTitle: post.title,
    postUrl: post.url,
    permalink: post.url,
    matchedTerms,
    evidenceSnippet,
    score,
    signalBreakdown: { recency, engagement, termMatch, intent, subredditFit },
    recommendedAction,
    status: 'new',
  };
}

export function rankOpportunities(
  posts: Array<{ post: NormalizedRedditPost; matchedTerms: string[] }>,
  context: RedditScanContext
): ScoredOpportunity[] {
  const seen = new Set<string>();
  const scored: ScoredOpportunity[] = [];

  for (const entry of posts) {
    if (seen.has(entry.post.url)) continue;
    seen.add(entry.post.url);
    if (entry.matchedTerms.length === 0) continue;
    scored.push(scoreOpportunity(entry.post, context, entry.matchedTerms));
  }

  scored.sort((a, b) => b.score - a.score);
  return scored
    .filter((o) => o.score >= context.scanConfig.threshold)
    .slice(0, context.scanConfig.resultCap);
}
