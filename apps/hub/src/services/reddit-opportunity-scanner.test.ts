import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockRunSingleTurnAgent = mock(async () =>
  JSON.stringify({
    whatTheySell: 'Analytics platform',
    mainKeywords: ['analytics'],
    competitors: ['Mixpanel'],
    evidence: ['Homepage'],
    keywords: [{ label: 'analytics', reason: 'core', confidence: 0.9 }],
    subreddits: [{ label: 'SaaS', reason: 'buyers', confidence: 0.8 }],
  })
);

const mockRunCredentialTool = mock(async (_db, _tenant, toolName: string) => {
  if (toolName === 'firecrawl_scrape') {
    return JSON.stringify({ success: true, data: { markdown: '# Analytics SaaS' } });
  }
  if (toolName === 'reddit_search') {
    return JSON.stringify([
      {
        url: 'https://reddit.com/r/SaaS/comments/1',
        title: 'Need analytics advice',
        publishedAt: new Date().toISOString(),
        source: 'reddit',
        engagement: { upvotes: 20, comments: 5 },
        author: 'r/SaaS',
      },
    ]);
  }
  return '[]';
});

mock.module('../lib/inference', () => ({
  runSingleTurnAgent: mockRunSingleTurnAgent,
}));

mock.module('../lib/run-credential-tool', () => ({
  runCredentialTool: mockRunCredentialTool,
}));

const { runRedditOpportunityAnalyze, runRedditOpportunityScan } =
  await import('./reddit-opportunity-scanner');

type HubDb = import('../db').HubDb;

function createDb() {
  const artifacts: Array<{
    id: string;
    sessionId: string;
    kind: string;
    status: string;
    content: string;
    source?: Record<string, unknown>;
    createdAt: Date;
  }> = [];

  const db = {
    query: {
      workflowRun: {
        findFirst: async () => ({
          id: 'wf-1',
          status: 'pending',
          input: { inputUrl: 'https://corbits.dev', brandName: 'Corbits' },
        }),
      },
      artifact: {
        findMany: async ({ where }: { where?: unknown }) => {
          void where;
          return artifacts;
        },
      },
    },
    update: () => ({
      set: () => ({
        where: async () => undefined,
      }),
    }),
    transaction: async (fn: (tx: HubDb) => Promise<unknown>) => fn(db as unknown as HubDb),
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        returning: async () => {
          const id = `art-${artifacts.length + 1}`;
          artifacts.push({
            id,
            sessionId: row.sessionId as string,
            kind: row.kind as string,
            status: row.status as string,
            content: row.content as string,
            source: row.source as Record<string, unknown> | undefined,
            createdAt: new Date(),
          });
          return [{ id }];
        },
      }),
    }),
  };

  return { db: db as unknown as HubDb, artifacts };
}

const USER = { tenantId: 'ten-1', principalId: 'pr-1' };
const SOURCE = {
  id: 'openai:gpt',
  provider: 'openai-compatible',
  baseURL: 'https://api.example.com',
  apiKey: 'key',
  model: 'gpt',
};

describe('reddit opportunity scanner service', () => {
  beforeEach(() => {
    mockRunSingleTurnAgent.mockClear();
    mockRunCredentialTool.mockClear();
  });

  it('analyze persists a draft artifact and moves to reviewing', async () => {
    const { db, artifacts } = createDb();
    await runRedditOpportunityAnalyze(db, 'wf-1', USER, SOURCE);

    expect(mockRunCredentialTool).toHaveBeenCalled();
    expect(mockRunSingleTurnAgent).toHaveBeenCalled();
    const draft = artifacts.find((a) => a.kind === 'reddit-opportunity-scan' && a.status === 'draft');
    expect(draft).toBeDefined();
    expect(draft?.source?.brief).toMatchObject({
      artifactType: 'reddit-opportunity-scan',
      inputUrl: 'https://corbits.dev',
    });
  });

  it('scan persists an approved artifact with opportunities', async () => {
    const { db, artifacts } = createDb();
    await runRedditOpportunityAnalyze(db, 'wf-1', USER, SOURCE);
    await runRedditOpportunityScan(db, 'wf-1', USER, SOURCE);

    expect(mockRunCredentialTool.mock.calls.some((call) => call[2] === 'reddit_search')).toBe(true);
    const approved = artifacts.find(
      (a) => a.kind === 'reddit-opportunity-scan' && a.status === 'approved'
    );
    expect(approved).toBeDefined();
    expect(approved?.source?.brief).toMatchObject({
      artifactType: 'reddit-opportunity-scan',
      inputUrl: 'https://corbits.dev',
    });
  });
});
