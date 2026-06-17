import type { RedditAnalyzeInput } from './types';

export function buildAnalyzeSystemPrompt(): string {
  return `You are a GTM research analyst. Given website content, infer what the business sells, who it serves, and where to find relevant Reddit conversations.

Return JSON only with this shape:
{
  "whatTheySell": "string",
  "mainKeywords": ["string"],
  "competitors": ["string"],
  "audienceNotes": "string",
  "evidence": ["short evidence snippets from the site"],
  "keywords": [{ "label": "string", "reason": "string", "confidence": 0.0-1.0 }],
  "subreddits": [{ "label": "string without r/ prefix", "reason": "string", "confidence": 0.0-1.0 }]
}

Rules:
- keywords: 5-12 search terms an operator would monitor on Reddit (product category, pain points, buyer intent).
- subreddits: 4-8 communities where the ICP discusses problems this product solves.
- competitors: real alternatives mentioned or implied; empty array if none found.
- evidence: 2-5 short quotes or page references supporting the summary.
- Do not invent facts absent from the site content or optional hints.`;
}

export function buildAnalyzeUserMessage(input: RedditAnalyzeInput, siteContent: string): string {
  const hints: string[] = [`Website URL: ${input.inputUrl}`];
  if (input.brandName) hints.push(`Brand name: ${input.brandName}`);
  if (input.targetGeography) hints.push(`Target geography: ${input.targetGeography}`);
  if (input.icpHints) hints.push(`ICP hints: ${input.icpHints}`);

  return `${hints.join('\n')}

<site_content>
${siteContent}
</site_content>

Analyze the business and return JSON only.`;
}

export function buildExportSystemPrompt(): string {
  return `You write concise GTM operator briefs from ranked Reddit opportunities.

Return JSON only:
{
  "channelBrief": "markdown string — which subreddits matter and what to watch for",
  "responsePlaybook": "markdown string — engagement angles by intent type",
  "opportunityFeed": "markdown bullet list of top threads with scores and one-line actions"
}`;
}

export function buildExportUserMessage(context: {
  inputUrl: string;
  brandName?: string;
  businessSummary: string;
  opportunities: Array<{
    subreddit: string;
    postTitle: string;
    score: number;
    matchedTerms: string[];
    recommendedAction: string;
    permalink: string;
  }>;
}): string {
  const lines = context.opportunities.map(
    (o) =>
      `- r/${o.subreddit} (score ${o.score}): ${o.postTitle} | terms: ${o.matchedTerms.join(', ')} | action: ${o.recommendedAction} | ${o.permalink}`
  );
  return `Business: ${context.brandName ?? context.inputUrl}
Summary: ${context.businessSummary}

Ranked opportunities:
${lines.join('\n')}

Write the three export views. Return JSON only.`;
}
