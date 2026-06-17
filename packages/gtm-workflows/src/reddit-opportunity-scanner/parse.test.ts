import { describe, expect, it } from 'bun:test';
import { extractMarkdownFromFirecrawlResult, parseAnalyzeReply } from './parse';

describe('reddit opportunity parse', () => {
  it('parses analyze JSON from a fenced reply', () => {
    const reply = `Here is the analysis:
\`\`\`json
{
  "whatTheySell": "Developer tools",
  "mainKeywords": ["devtools"],
  "competitors": ["GitHub"],
  "evidence": ["Homepage"],
  "keywords": [{ "label": "devtools", "reason": "core", "confidence": 0.9 }],
  "subreddits": [{ "label": "programming", "reason": "audience", "confidence": 0.8 }]
}
\`\`\``;
    const parsed = parseAnalyzeReply(reply);
    expect(parsed.whatTheySell).toBe('Developer tools');
    expect(parsed.keywords[0]?.label).toBe('devtools');
  });

  it('extracts markdown from firecrawl scrape payloads', () => {
    const raw = JSON.stringify({ success: true, data: { markdown: '# Hello' } });
    expect(extractMarkdownFromFirecrawlResult(raw)).toBe('# Hello');
  });
});
