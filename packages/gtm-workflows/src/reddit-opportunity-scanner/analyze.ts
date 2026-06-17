import { REDDIT_OPPORTUNITY_SCAN_ARTIFACT_KIND } from './schema';
import type { RedditOpportunityScanArtifact } from './schema';
import { DEFAULT_SCAN_CONFIG, MAX_SITE_CONTENT_CHARS } from './constants';
import { buildAnalyzeSystemPrompt, buildAnalyzeUserMessage } from './prompts';
import { parseAnalyzeReply } from './parse';
import type { AnalyzeDeps, RedditAnalyzeInput } from './types';

function truncateContent(content: string): string {
  if (content.length <= MAX_SITE_CONTENT_CHARS) return content;
  return `${content.slice(0, MAX_SITE_CONTENT_CHARS)}\n\n[truncated]`;
}

export async function analyzeWebsite(
  input: RedditAnalyzeInput,
  deps: AnalyzeDeps
): Promise<RedditOpportunityScanArtifact> {
  const rawSite = await deps.scrapeSite(input.inputUrl);
  const siteContent = truncateContent(rawSite);

  const reply = await deps.infer({
    systemPrompt: buildAnalyzeSystemPrompt(),
    userMessage: buildAnalyzeUserMessage(input, siteContent),
  });
  const parsed = parseAnalyzeReply(reply);

  const title = input.brandName
    ? `Reddit opportunities for ${input.brandName}`
    : 'Reddit opportunities';

  return {
    artifactType: REDDIT_OPPORTUNITY_SCAN_ARTIFACT_KIND,
    title,
    summary: `Business analysis for ${input.inputUrl}. Review keywords and subreddits before scanning Reddit.`,
    inputUrl: input.inputUrl,
    brandName: input.brandName,
    targetGeography: input.targetGeography,
    icpHints: input.icpHints,
    businessProfile: {
      whatTheySell: parsed.whatTheySell,
      mainKeywords: parsed.mainKeywords,
      competitors: parsed.competitors,
      audienceNotes: parsed.audienceNotes,
      evidence: parsed.evidence,
    },
    recommendations: {
      keywords: parsed.keywords.map((item) => ({
        label: item.label,
        reason: item.reason,
        confidence: item.confidence,
        source: 'inferred' as const,
      })),
      subreddits: parsed.subreddits.map((item) => ({
        label: item.label.replace(/^r\//i, ''),
        reason: item.reason,
        confidence: item.confidence,
        source: 'inferred' as const,
      })),
    },
    scanConfig: { ...DEFAULT_SCAN_CONFIG },
    opportunities: [],
    watchlist: {
      keywords: parsed.keywords.map((k) => k.label),
      subreddits: parsed.subreddits.map((s) => s.label.replace(/^r\//i, '')),
      competitors: parsed.competitors,
      lastScannedAt: new Date().toISOString(),
    },
    exports: {
      channelBrief: '',
      responsePlaybook: '',
      opportunityFeed: '',
    },
  };
}
