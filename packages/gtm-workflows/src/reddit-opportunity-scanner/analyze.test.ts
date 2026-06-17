import { describe, expect, it } from 'bun:test';
import { analyzeWebsite } from './analyze';

describe('analyzeWebsite', () => {
  it('builds a draft artifact from scrape + inference', async () => {
    const draft = await analyzeWebsite(
      { inputUrl: 'https://corbits.dev', brandName: 'Corbits' },
      {
        scrapeSite: async () => '# Corbits\nAI infrastructure for developers.',
        infer: async () =>
          JSON.stringify({
            whatTheySell: 'AI infrastructure',
            mainKeywords: ['ai infra'],
            competitors: [],
            evidence: ['Homepage'],
            keywords: [{ label: 'ai infra', reason: 'core', confidence: 0.9 }],
            subreddits: [{ label: 'MachineLearning', reason: 'audience', confidence: 0.7 }],
          }),
      }
    );

    expect(draft.brandName).toBe('Corbits');
    expect(draft.recommendations.keywords[0]?.source).toBe('inferred');
    expect(draft.opportunities).toHaveLength(0);
  });
});
