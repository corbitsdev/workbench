import { and, eq, max } from 'drizzle-orm';
import { getLogger } from '@intx/log';
import type { InferenceSource } from '@intx/types/runtime';
import {
  analyzeWebsite,
  extractMarkdownFromFirecrawlResult,
  parseRedditOpportunityScanArtifact,
  REDDIT_OPPORTUNITY_SCAN_ARTIFACT_KIND,
  scanOpportunities,
  type NormalizedRedditPost,
} from '@workbench/gtm-workflows/reddit-opportunity-scanner';
import type { UserContext } from '@workbench/workflow-core';
import type { HubDb } from '../db';
import { artifact, artifactVersion, workflowRun } from '../db/schema';
import { runSingleTurnAgent } from '../lib/inference';
import { runCredentialTool } from '../lib/run-credential-tool';

const log = getLogger(['service', 'reddit-opportunity-scanner']);

export class RedditOpportunityScannerError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'RedditOpportunityScannerError';
  }
}

function redditArtifactSource(content: string): Record<string, unknown> | undefined {
  const parsed = parseRedditOpportunityScanArtifact(JSON.parse(content));
  if (!parsed) return undefined;
  return { brief: parsed };
}

async function insertArtifactWithVersion(
  db: HubDb,
  values: {
    tenantId: string;
    principalId: string;
    ownerPrincipalId: string;
    sessionId: string;
    kind: string;
    title: string;
    content: string;
    status: 'draft' | 'approved';
  }
): Promise<{ id: string }> {
  const source = redditArtifactSource(values.content);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(artifact)
      .values({ ...values, source, version: 1 })
      .returning({ id: artifact.id });
    if (!row) throw new Error('Failed to insert artifact');
    await tx.insert(artifactVersion).values({
      artifactId: row.id,
      version: 1,
      title: values.title,
      content: values.content,
      authorId: values.principalId,
    });
    if (!row) throw new RedditOpportunityScannerError('Artifact creation failed', 500);
    return row;
  });
}

function parseRedditPosts(raw: string): NormalizedRedditPost[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is NormalizedRedditPost =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as NormalizedRedditPost).url === 'string' &&
      typeof (item as NormalizedRedditPost).title === 'string'
  );
}

export async function getLatestDraftRedditScan(
  db: HubDb,
  workflowId: string
): Promise<{ id: string; content: string } | null> {
  const rows = await db.query.artifact.findMany({
    where: and(
      eq(artifact.sessionId, workflowId),
      eq(artifact.kind, REDDIT_OPPORTUNITY_SCAN_ARTIFACT_KIND)
    ),
    orderBy: (a, { desc }) => [desc(a.createdAt)],
  });
  const draft = rows.find((row) => row.status === 'draft');
  if (!draft) return null;
  return { id: draft.id, content: draft.content };
}

export async function runRedditOpportunityAnalyze(
  db: HubDb,
  workflowId: string,
  userContext: UserContext,
  source: InferenceSource,
  maxOutputTokens?: number
): Promise<void> {
  const wf = await db.query.workflowRun.findFirst({ where: eq(workflowRun.id, workflowId) });
  if (!wf) throw new RedditOpportunityScannerError('Workflow not found', 404);

  const input = (wf.input as Record<string, unknown>) ?? {};
  const inputUrl = typeof input['inputUrl'] === 'string' ? input['inputUrl'] : '';
  if (!inputUrl) throw new RedditOpportunityScannerError('inputUrl is required', 400);

  const draft = await analyzeWebsite(
    {
      inputUrl,
      ...(typeof input['brandName'] === 'string' ? { brandName: input['brandName'] } : {}),
      ...(typeof input['targetGeography'] === 'string'
        ? { targetGeography: input['targetGeography'] }
        : {}),
      ...(typeof input['icpHints'] === 'string' ? { icpHints: input['icpHints'] } : {}),
    },
    {
      infer: ({ systemPrompt, userMessage }) =>
        runSingleTurnAgent(source, systemPrompt, userMessage, 'reddit-analyze', maxOutputTokens),
      scrapeSite: async (url) => {
        const raw = await runCredentialTool(db, userContext.tenantId, 'firecrawl_scrape', {
          url,
          formats: ['markdown'],
          onlyMainContent: true,
        });
        return extractMarkdownFromFirecrawlResult(raw);
      },
    }
  );

  await insertArtifactWithVersion(db, {
    tenantId: userContext.tenantId,
    principalId: userContext.principalId,
    ownerPrincipalId: userContext.principalId,
    sessionId: workflowId,
    kind: REDDIT_OPPORTUNITY_SCAN_ARTIFACT_KIND,
    title: 'Reddit Scan Draft',
    content: JSON.stringify(draft),
    status: 'draft',
  });

  await db.update(workflowRun).set({ status: 'reviewing' }).where(eq(workflowRun.id, workflowId));
  log.info('Reddit opportunity analyze complete', { workflowId });
}

export async function runRedditOpportunityScan(
  db: HubDb,
  workflowId: string,
  userContext: UserContext,
  source: InferenceSource,
  maxOutputTokens?: number
): Promise<void> {
  const draftRow = await getLatestDraftRedditScan(db, workflowId);
  if (!draftRow) {
    throw new RedditOpportunityScannerError('No draft reddit scan artifact found', 400);
  }

  const draft = parseRedditOpportunityScanArtifact(JSON.parse(draftRow.content));
  if (!draft) {
    throw new RedditOpportunityScannerError('Invalid draft reddit scan artifact', 400);
  }

  const final = await scanOpportunities(draft, {
    infer: ({ systemPrompt, userMessage }) =>
      runSingleTurnAgent(source, systemPrompt, userMessage, 'reddit-scan', maxOutputTokens),
    searchReddit: async (args) => {
      const raw = await runCredentialTool(db, userContext.tenantId, 'reddit_search', {
        query: args.query,
        timeframe: args.timeframe,
        limit: args.limit,
      });
      return parseRedditPosts(raw);
    },
    searchSubreddit: async (args) => {
      const raw = await runCredentialTool(db, userContext.tenantId, 'reddit_subreddit_search', {
        subreddit: args.subreddit,
        query: args.query,
        timeframe: args.timeframe,
        limit: args.limit,
      });
      return parseRedditPosts(raw);
    },
  });

  await insertArtifactWithVersion(db, {
    tenantId: userContext.tenantId,
    principalId: userContext.principalId,
    ownerPrincipalId: userContext.principalId,
    sessionId: workflowId,
    kind: REDDIT_OPPORTUNITY_SCAN_ARTIFACT_KIND,
    title: 'Reddit Scan Results',
    content: JSON.stringify(final),
    status: 'approved',
  });

  await db.update(workflowRun).set({ status: 'done' }).where(eq(workflowRun.id, workflowId));
  log.info('Reddit opportunity scan complete', {
    workflowId,
    opportunities: final.opportunities.length,
  });
}

export async function updateRedditScanArtifactContent(
  db: HubDb,
  workflowId: string,
  artifactId: string,
  principalId: string,
  nextContent: string
) {
  return db.transaction(async (tx) => {
    const [fresh] = await tx
      .select({ content: artifact.content, title: artifact.title })
      .from(artifact)
      .where(and(eq(artifact.id, artifactId), eq(artifact.sessionId, workflowId)))
      .for('update');
    if (!fresh) throw new RedditOpportunityScannerError('Artifact not found', 404);

    const maxVersionResult = await tx
      .select({ maxVersion: max(artifactVersion.version) })
      .from(artifactVersion)
      .where(eq(artifactVersion.artifactId, artifactId));
    const nextVersion = (maxVersionResult[0]?.maxVersion ?? 0) + 1;

    const source = redditArtifactSource(nextContent);
    const [row] = await tx
      .update(artifact)
      .set({ content: nextContent, source, version: nextVersion })
      .where(eq(artifact.id, artifactId))
      .returning();

    await tx.insert(artifactVersion).values({
      artifactId,
      version: nextVersion,
      title: fresh.title,
      content: nextContent,
      authorId: principalId,
    });

    if (!row) throw new RedditOpportunityScannerError('Artifact update failed', 500);
    return row;
  });
}
