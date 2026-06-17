import type { RedditOpportunityScanArtifact } from './schema';

export type RedditAnalyzeInput = {
  inputUrl: string;
  brandName?: string;
  targetGeography?: string;
  icpHints?: string;
};

export type NormalizedRedditPost = {
  url: string;
  title: string;
  publishedAt: string;
  source: 'reddit';
  engagement: { upvotes: number; comments: number };
  author: string;
  topComments?: string[];
};

export type AnalyzeInference = (args: {
  systemPrompt: string;
  userMessage: string;
}) => Promise<string>;

export type AnalyzeDeps = {
  infer: AnalyzeInference;
  scrapeSite: (url: string) => Promise<string>;
};

export type ScanDeps = {
  infer: AnalyzeInference;
  searchReddit: (args: {
    query: string;
    timeframe?: string;
    limit?: number;
  }) => Promise<NormalizedRedditPost[]>;
  searchSubreddit: (args: {
    subreddit: string;
    query: string;
    timeframe?: string;
    limit?: number;
  }) => Promise<NormalizedRedditPost[]>;
};

export type AnalyzeReply = {
  whatTheySell: string;
  mainKeywords: string[];
  competitors: string[];
  audienceNotes?: string;
  evidence: string[];
  keywords: Array<{ label: string; reason: string; confidence: number }>;
  subreddits: Array<{ label: string; reason: string; confidence: number }>;
};

export type ExportReply = {
  channelBrief: string;
  responsePlaybook: string;
  opportunityFeed: string;
};

export type RedditScanContext = Pick<
  RedditOpportunityScanArtifact,
  'businessProfile' | 'recommendations' | 'scanConfig' | 'inputUrl' | 'brandName'
>;
