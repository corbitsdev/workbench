import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { getLogger } from '@intx/log';
import { createAgent } from '@intx/agent';
import type { InferenceSource } from '@intx/types/runtime';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifact, collateralGenerationWorkflow } from '../db/schema';

const log = getLogger(['api', 'collateral-generation']);

export const OUTPUT_TYPES = ['case-study', 'one-pager', 'email-draft'] as const;
export type OutputType = (typeof OUTPUT_TYPES)[number];

function isValidOutputType(value: string): value is OutputType {
  return (OUTPUT_TYPES as readonly string[]).includes(value);
}

function buildSystemPrompt(outputType: OutputType): string {
  switch (outputType) {
    case 'case-study':
      return `You are a senior B2B content strategist. Write a concise customer case study from the provided source materials.

Structure (use these exact markdown headers):
## Executive Summary
## The Challenge
## The Solution
## Results
## Key Takeaways

Rules:
- Use specific numbers, timelines, and quotes from the source materials
- "Results" section must include quantified outcomes where available
- Keep to 400-600 words total
- No buzzwords. No "synergy". No "leverage".
- Write as if the customer is the hero, not the vendor

Return JSON: { "title": "<Company Name: Short outcome headline>", "body": "<full markdown body>" }`;

    case 'one-pager':
      return `You are a senior sales copywriter. Write a one-pager the prospect can share internally or paste into a deck.

Structure (use these exact markdown headers):
## The Problem
## The Evidence
## What We Deliver
## The Math
## Next Step

Rules:
- Every section must use specific details from the source materials: numbers, team size, timeline, exact quotes
- "The Evidence" section: name the incident, the dollar figure, the timeline
- "The Math" section: show the savings calculation with actual numbers from the source
- "What We Deliver": 3-5 bullet points, each tied to a specific pain in the source material
- "Next Step": one sentence, one action, specific
- No buzzwords.

Return JSON: { "title": "<action-oriented title, specific to their situation>", "body": "<full markdown body>" }`;

    case 'email-draft':
      return `You are a senior outbound sales rep. Write a follow-up email from the seller to the primary prospect contact. It must read like a human wrote it.

Structure (mandatory):
- Subject line: 6-10 words, sentence case, references their specific situation
- Greeting: Hi [First Name], on its own line
- Paragraph 1 (1-2 sentences): One punchy observation grounded in what they said. No intro, no preamble.
- Paragraph 2 (2 sentences max): What solving this unlocks for them specifically.
- Paragraph 3 (1-2 sentences): One concrete next step with a specific day or action.
- Sign off with your name only.

Humanizer rules (non-negotiable):
- No "I hope this finds you well". No "excited to share". No "just reaching out". No em dashes.
- Write how a person talks, not how a copywriter edits.

Return JSON: { "title": "<subject line>", "body": "<full email text, newlines as \\n>" }`;
  }
}

async function generateArtifactWithLLM(
  workflowId: string,
  outputType: OutputType,
  sourceContent: string
): Promise<{ title: string; body: string }> {
  const apiKey = process.env.OPENAI_COMPATIBLE_API_KEY;
  const model = process.env.OPENAI_COMPATIBLE_MODEL ?? 'gpt-4o-mini';
  const baseURL = process.env.OPENAI_COMPATIBLE_BASE_URL ?? 'https://api.openai.com/v1';

  if (!apiKey) {
    throw new Error('OPENAI_COMPATIBLE_API_KEY is required for collateral generation');
  }

  log.info('Generating artifact', { workflowId, outputType });

  const source: InferenceSource = {
    id: `collateral-gen-${workflowId}`,
    provider: 'openai',
    baseURL,
    apiKey,
    model,
  };

  const userMessage = `Source materials:\n\n${sourceContent.slice(0, 80000)}\n\n---\n\nGenerate ${outputType} collateral now.`;

  const contextDir = join(tmpdir(), `collateral-gen-${randomUUID()}`);
  const agent = await createAgent({
    contextDir,
    sources: [source],
    defaultSource: source.id,
    systemPrompt: buildSystemPrompt(outputType),
    tools: [],
    closeTimeoutMs: 1000,
  });

  let raw: string;
  try {
    const result = await agent.send(userMessage);
    raw = result.reply;
  } finally {
    await agent.close();
  }

  if (!raw) throw new Error('LLM returned empty content');

  let parsed: { title?: string; body?: string };
  try {
    parsed = JSON.parse(raw) as { title?: string; body?: string };
  } catch {
    log.error('Invalid JSON from LLM', { workflowId, outputType, raw: raw.substring(0, 200) });
    throw new Error('LLM returned invalid JSON');
  }

  if (!parsed.title || !parsed.body) {
    throw new Error('LLM response missing title or body');
  }

  return { title: parsed.title.slice(0, 500), body: parsed.body.slice(0, 20000) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createCollateralGenerationRouter(db: any): Hono<{ Variables: { userId: string } }> {
  const router = new Hono<{ Variables: { userId: string } }>();

  // ─── Create collateral-generation workflow ─────────────────────────
  router.post('/collateral-generation', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      kind?: string;
      inputArtifactIds?: unknown;
      outputTypes?: unknown;
    };

    if (!Array.isArray(body.inputArtifactIds) || body.inputArtifactIds.length === 0) {
      log.warn('Missing or empty inputArtifactIds');
      return c.json({ error: 'inputArtifactIds must be a non-empty array' }, 400);
    }

    if (!Array.isArray(body.outputTypes) || body.outputTypes.length === 0) {
      log.warn('Missing or empty outputTypes');
      return c.json({ error: 'outputTypes must be a non-empty array' }, 400);
    }

    const inputArtifactIds = body.inputArtifactIds as string[];
    const outputTypes = body.outputTypes as string[];

    const invalidTypes = outputTypes.filter((t) => !isValidOutputType(t));
    if (invalidTypes.length > 0) {
      log.warn('Invalid outputTypes', { invalidTypes });
      return c.json(
        {
          error: `Invalid output types: ${invalidTypes.join(', ')}. Must be one of: ${OUTPUT_TYPES.join(', ')}`,
        },
        400
      );
    }

    const userId = c.get('userId');

    const [wf] = await db
      .insert(collateralGenerationWorkflow)
      .values({ userId, inputArtifactIds, outputTypes, status: 'pending' })
      .returning();

    log.info('Collateral generation workflow created', {
      workflowId: wf.id,
      inputCount: inputArtifactIds.length,
      outputTypes,
    });

    // Kick off generation asynchronously — do not await
    void runGeneration(db, wf.id, inputArtifactIds, outputTypes as OutputType[]).catch((err) => {
      log.error('Generation failed', {
        workflowId: wf.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return c.json({ id: wf.id, status: wf.status }, 201);
  });

  // ─── Get workflow state ─────────────────────────────────────────────
  router.get('/collateral-generation/:id', async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');

    const wf = await db.query.collateralGenerationWorkflow.findFirst({
      where: and(
        eq(collateralGenerationWorkflow.id, id),
        eq(collateralGenerationWorkflow.userId, userId)
      ),
    });

    if (!wf) {
      log.warn('Collateral generation workflow not found', { workflowId: id });
      return c.json({ error: 'Workflow not found' }, 404);
    }

    const artifacts = await db.query.artifact.findMany({
      where: eq(artifact.workflowId, id),
    });

    const outputs: Record<string, { status: string; artifactId?: string; title?: string }> = {};
    for (const ot of wf.outputTypes as string[]) {
      const art = artifacts.find((a: { kind: string }) => a.kind === ot);
      if (art) {
        outputs[ot] = { status: art.status, artifactId: art.id, title: art.title };
      } else {
        outputs[ot] = { status: 'pending' };
      }
    }

    return c.json({
      id: wf.id,
      status: wf.status,
      inputArtifactIds: wf.inputArtifactIds,
      outputTypes: wf.outputTypes,
      outputs,
      createdAt: wf.createdAt,
      updatedAt: wf.updatedAt,
    });
  });

  // ─── List all generated artifacts for current user ──────────────────
  router.get('/artifacts', async (c) => {
    const userId = c.get('userId');

    // Find all workflows belonging to this user
    const workflows = await db.query.collateralGenerationWorkflow.findMany({
      where: eq(collateralGenerationWorkflow.userId, userId),
      orderBy: [desc(collateralGenerationWorkflow.createdAt)],
      limit: 100,
    });

    if (workflows.length === 0) {
      return c.json({ artifacts: [] });
    }

    const workflowIds = workflows.map((w: { id: string }) => w.id);

    // Pull all artifacts associated with these workflows
    const { inArray } = await import('drizzle-orm');
    const artifacts = await db.query.artifact.findMany({
      where: inArray(artifact.workflowId, workflowIds),
      orderBy: [desc(artifact.createdAt)],
    });

    return c.json({
      artifacts: artifacts.map(serializeArtifact),
    });
  });

  return router;
}

// ─── Generation runner ──────────────────────────────────────────────

async function runGeneration(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  workflowId: string,
  inputArtifactIds: string[],
  outputTypes: OutputType[]
): Promise<void> {
  log.info('Starting generation run', { workflowId, outputTypes });

  await db
    .update(collateralGenerationWorkflow)
    .set({ status: 'generating' })
    .where(eq(collateralGenerationWorkflow.id, workflowId));

  // Compose source content from input artifact IDs.
  // In production these would be fetched from a real artifact store.
  // For now, use the artifact IDs as labels so the LLM has context about what was selected.
  const sourceContent = `Input artifacts selected by user: ${inputArtifactIds.join(', ')}\n\nGenerate high-quality collateral based on these artifact references.`;

  // Insert placeholder artifact rows so GET can reflect per-type status
  const placeholders = await Promise.all(
    outputTypes.map((ot) =>
      db
        .insert(artifact)
        .values({
          workflowId,
          sessionId: null,
          kind: ot,
          title: '',
          content: '',
          status: 'draft',
          version: 1,
        })
        .returning()
        .then((rows: { id: string }[]) => {
          const row = rows[0];
          if (!row) throw new Error(`Failed to insert artifact for ${ot}`);
          return { id: row.id, outputType: ot };
        })
    )
  );

  // Generate each output type in parallel
  const results = await Promise.allSettled(
    placeholders.map(async ({ id, outputType }) => {
      try {
        const { title, body } = await generateArtifactWithLLM(
          workflowId,
          outputType,
          sourceContent
        );
        await db
          .update(artifact)
          .set({ title, content: body, status: 'approved' })
          .where(eq(artifact.id, id));
        log.info('Artifact generated', { workflowId, outputType, artifactId: id });
      } catch (err) {
        await db.update(artifact).set({ status: 'draft' }).where(eq(artifact.id, id));
        log.error('Artifact generation failed', {
          workflowId,
          outputType,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    })
  );

  const anyFailed = results.some((r) => r.status === 'rejected');
  const allFailed = results.every((r) => r.status === 'rejected');

  const finalStatus = allFailed ? 'failed' : anyFailed ? 'done' : 'done';

  await db
    .update(collateralGenerationWorkflow)
    .set({ status: finalStatus })
    .where(eq(collateralGenerationWorkflow.id, workflowId));

  log.info('Generation run complete', { workflowId, finalStatus });
}

// ─── Serialization ──────────────────────────────────────────────────

function serializeArtifact(a: {
  id: string;
  workflowId: string | null;
  kind: string;
  title: string;
  content: string;
  status: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}) {
  return {
    id: a.id,
    workflowId: a.workflowId,
    kind: a.kind,
    title: a.title,
    content: a.content,
    status: a.status,
    createdAt: typeof a.createdAt === 'string' ? a.createdAt : a.createdAt.toISOString(),
    updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : a.updatedAt.toISOString(),
  };
}
