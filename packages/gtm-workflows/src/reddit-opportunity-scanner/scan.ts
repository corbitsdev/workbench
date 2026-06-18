import type { RedditOpportunityScanArtifact } from './schema';
import { REDDIT_SEARCH_CONCURRENCY, SCAN_TIME_WINDOW_TO_REDDIT } from './constants';
import { buildExportSystemPrompt, buildExportUserMessage } from './prompts';
import { parseExportReply } from './parse';
import { collectSearchTerms, rankOpportunities } from './scoring';
import type { NormalizedRedditPost, ScanDeps } from './types';

type SearchTask = {
  mode: 'global' | 'subreddit';
  query: string;
  subreddit?: string;
};

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, width: number): Promise<T[]> {
  const results: T[] = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const current = index;
      index += 1;
      results[current] = await tasks[current]!();
    }
  }

  const workers = Array.from({ length: Math.min(width, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function buildSearchTasks(draft: RedditOpportunityScanArtifact): SearchTask[] {
  const terms = collectSearchTerms(draft);
  const subreddits = draft.recommendations.subreddits
    .filter((s) => s.source !== 'rejected')
    .map((s) => s.label.replace(/^r\//i, ''))
    .filter((s) => s.length > 0);

  const tasks: SearchTask[] = terms.map((query) => ({ mode: 'global', query }));
  for (const subreddit of subreddits) {
    for (const query of terms.slice(0, 5)) {
      tasks.push({ mode: 'subreddit', query, subreddit });
    }
  }
  return tasks;
}

function matchTermsForPost(post: NormalizedRedditPost, terms: string[]): string[] {
  const haystack = `${post.title} ${post.topComments?.join(' ') ?? ''}`.toLowerCase();
  return terms.filter((term) => term.length > 0 && haystack.includes(term.toLowerCase()));
}

export async function scanOpportunities(
  draft: RedditOpportunityScanArtifact,
  deps: ScanDeps
): Promise<RedditOpportunityScanArtifact> {
  const terms = collectSearchTerms(draft);
  const timeframe = SCAN_TIME_WINDOW_TO_REDDIT[draft.scanConfig.timeWindow] ?? 'month';
  const perQueryLimit = Math.max(5, Math.ceil(draft.scanConfig.resultCap / 2));
  const tasks = buildSearchTasks(draft);

  const searchFns = tasks.map((task) => async () => {
    if (task.mode === 'subreddit' && task.subreddit) {
      return deps.searchSubreddit({
        subreddit: task.subreddit,
        query: task.query,
        timeframe,
        limit: perQueryLimit,
      });
    }
    return deps.searchReddit({
      query: task.query,
      timeframe,
      limit: perQueryLimit,
    });
  });

  const batches = await runWithConcurrency(searchFns, REDDIT_SEARCH_CONCURRENCY);
  const hits = batches.flat().map((post) => ({
    post,
    matchedTerms: matchTermsForPost(post, terms),
  }));

  const opportunities = rankOpportunities(hits, draft);

  let exports = {
    channelBrief: `Monitor ${draft.recommendations.subreddits
      .filter((s) => s.source !== 'rejected')
      .map((s) => `r/${s.label.replace(/^r\//i, '')}`)
      .join(', ')} for buyer-intent threads matching ${terms.slice(0, 5).join(', ')}.`,
    responsePlaybook:
      'Lead with a helpful answer, cite a concrete benchmark or checklist, and only mention the product when asked.',
    opportunityFeed: opportunities
      .map((o) => `- [${o.score}] r/${o.subreddit}: ${o.postTitle} — ${o.recommendedAction}`)
      .join('\n'),
  };

  if (opportunities.length > 0) {
    try {
      const exportReply = await deps.infer({
        systemPrompt: buildExportSystemPrompt(),
        userMessage: buildExportUserMessage({
          inputUrl: draft.inputUrl,
          ...(draft.brandName !== undefined ? { brandName: draft.brandName } : {}),
          businessSummary: draft.businessProfile.whatTheySell,
          opportunities: opportunities.slice(0, 8).map((o) => ({
            subreddit: o.subreddit,
            postTitle: o.postTitle,
            score: o.score,
            matchedTerms: o.matchedTerms,
            recommendedAction: o.recommendedAction,
            permalink: o.permalink,
          })),
        }),
      });
      exports = parseExportReply(exportReply);
    } catch {
      // deterministic exports above are sufficient fallback
    }
  }

  const approvedKeywords = draft.recommendations.keywords
    .filter((k) => k.source !== 'rejected')
    .map((k) => k.label);
  const approvedSubreddits = draft.recommendations.subreddits
    .filter((s) => s.source !== 'rejected')
    .map((s) => s.label.replace(/^r\//i, ''));

  return {
    ...draft,
    summary: `Found ${opportunities.length} Reddit opportunities for ${draft.inputUrl}.`,
    opportunities,
    watchlist: {
      keywords: approvedKeywords,
      subreddits: approvedSubreddits,
      competitors: draft.businessProfile.competitors,
      lastScannedAt: new Date().toISOString(),
    },
    exports,
  };
}
