import { Hono } from 'hono';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getLogger } from '@intx/log';
import {
  workbenchSession,
  transcript,
  painPoint,
  collateralItem,
  collateralVersion,
} from '../db/schema';
import { GranolaClient } from '../lib/granola';
import { extractPainPoints } from '../lib/extraction';
import { refineFeedbackWithLLM } from '../lib/feedback';
import { generateCollateralWithLLM } from '../lib/generation';

const log = getLogger(['api', 'workflow']);

const STEP_ORDER = ['intake', 'analyze', 'generate', 'improve', 'export'] as const;
type StepName = (typeof STEP_ORDER)[number];

const VALID_EXPORT_TARGETS = ['markdown', 'csv', 'json'] as const;
type ExportTarget = (typeof VALID_EXPORT_TARGETS)[number];

export function createWorkflowRouter(db: any): Hono<{ Variables: { userId: string } }> {
  const router = new Hono<{ Variables: { userId: string } }>();

  let granolaClient: GranolaClient | null = null;
  try {
    granolaClient = new GranolaClient();
  } catch {
    // Granola not configured
  }

  // ─── Create workflow (intake) ─────────────────────────────────────
  router.post('/workflows', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      transcript?: string;
      granolaId?: string;
      source?: string;
    };

    log.info('Creating workflow', { source: body.source });

    if (!body.source || !['paste', 'granola'].includes(body.source)) {
      log.warn('Invalid source', { source: body.source });
      return c.json({ error: 'Invalid source' }, 400);
    }

    let content: string;

    if (body.source === 'paste') {
      if (!body.transcript || body.transcript.trim().length === 0) {
        log.warn('Missing transcript for paste source');
        return c.json({ error: 'transcript is required' }, 400);
      }
      if (body.transcript.length > 500000) {
        log.warn('Transcript too long', { length: body.transcript.length });
        return c.json({ error: 'transcript exceeds maximum length' }, 413);
      }
      content = body.transcript;
      log.info('Transcript received', { length: content.length });
    } else {
      if (!body.granolaId) {
        log.warn('Missing granolaId for granola source');
        return c.json({ error: 'granolaId is required' }, 400);
      }
      if (!granolaClient) {
        log.warn('Granola API not configured');
        return c.json({ error: 'Granola API not configured' }, 503);
      }
      try {
        const note = await (granolaClient as GranolaClient).getNoteWithTranscript(body.granolaId);
        content = GranolaClient.transcriptToText(note) || note.summary || note.title || '';
        log.info('Granola note fetched', { granolaId: body.granolaId, length: content.length });
      } catch (err) {
        log.error('Failed to fetch from Granola', {
          granolaId: body.granolaId,
          error: err instanceof Error ? err.message : String(err),
        });
        return c.json({ error: 'Failed to fetch from Granola' }, 400);
      }
      if (content.trim().length === 0) {
        log.warn('Granola note has no usable content', { granolaId: body.granolaId });
        return c.json({ error: 'Granola note has no usable content' }, 400);
      }
    }

    const userId = c.get('userId');

    const [txRow] = await db
      .insert(transcript)
      .values({ content, source: body.source })
      .returning();
    const [wfRow] = await db
      .insert(workbenchSession)
      .values({ transcriptId: txRow.id, userId, status: 'analyzing' })
      .returning();

    log.info('Workflow created', {
      workflowId: wfRow.id,
      transcriptId: txRow.id,
      status: wfRow.status,
    });

    return c.json(
      {
        id: wfRow.id,
        status: wfRow.status,
        steps: {
          intake: { completed: true, transcriptId: txRow.id },
        },
      },
      201
    );
  });

  // ─── List workflows ─────────────────────────────────────────────────
  router.get('/workflows', async (c) => {
    const userId = c.get('userId');
    const sessions = await db.query.workbenchSession.findMany({
      where: eq(workbenchSession.userId, userId),
      orderBy: [desc(workbenchSession.createdAt)],
      limit: 50,
    });

    const rows = await Promise.all(
      sessions.map(async (s: (typeof sessions)[number]) => {
        const tx = await db.query.transcript.findFirst({
          where: eq(transcript.id, s.transcriptId),
        });
        const points = await db.query.painPoint.findMany({
          where: eq(painPoint.sessionId, s.id),
          columns: { id: true, context: true },
        });
        return {
          id: s.id,
          status: s.status,
          createdAt: s.createdAt,
          transcriptId: s.transcriptId,
          companyName: s.companyName ?? null,
          transcriptPreview: tx?.content?.slice(0, 80) ?? null,
          painPointCount: points.length,
          firstPainPoint: points[0]?.context ?? null,
        };
      })
    );

    return c.json(rows);
  });

  // ─── Read workflow ──────────────────────────────────────────────────
  router.get('/workflows/:id', async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    log.info('Fetching workflow', { workflowId: id });

    const wf = await db.query.workbenchSession.findFirst({
      where: and(eq(workbenchSession.id, id), eq(workbenchSession.userId, userId)),
    });
    if (!wf) {
      log.warn('Workflow not found', { workflowId: id });
      return c.json({ error: 'Workflow not found' }, 404);
    }

    const tx = await db.query.transcript.findFirst({
      where: eq(transcript.id, wf.transcriptId),
    });

    const points = await db.query.painPoint.findMany({
      where: eq(painPoint.sessionId, id),
    });

    const pointIds = points.map((p: any) => p.id);
    const allCollateral =
      pointIds.length > 0
        ? await db.query.collateralItem.findMany({
            where: inArray(collateralItem.painPointId, pointIds),
          })
        : [];

    const currentStep = deriveCurrentStep(wf.status);
    log.info('Workflow fetched', {
      workflowId: id,
      currentStep,
      painPointsCount: points.length,
      collateralCount: allCollateral.length,
    });

    return c.json({
      id,
      status: wf.status,
      currentStep,
      companyName: wf.companyName ?? null,
      steps: {
        intake: { completed: true, transcriptId: wf.transcriptId, transcript: tx?.content },
        analyze: { completed: points.length > 0, painPoints: points.map(serializePainPoint) },
        generate: {
          completed: allCollateral.length > 0,
          collateral: allCollateral.map(serializeCollateral),
        },
        improve: { completed: false },
        export: { completed: false },
      },
    });
  });

  // ─── Run step ───────────────────────────────────────────────────────
  router.post('/workflows/:id/steps', async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    const body = (await c.req.json().catch(() => ({}))) as {
      step?: StepName;
      painPointIds?: string[];
      collateralId?: string;
      feedback?: string;
      target?: string;
    };

    log.info('Running step', { workflowId: id, step: body.step });

    const wf = await db.query.workbenchSession.findFirst({
      where: and(eq(workbenchSession.id, id), eq(workbenchSession.userId, userId)),
    });
    if (!wf) {
      log.warn('Workflow not found for step', { workflowId: id });
      return c.json({ error: 'Workflow not found' }, 404);
    }

    const step = body.step ?? deriveCurrentStep(wf.status);

    if (step === 'analyze') {
      return runAnalyze(db, id, userId, body.feedback);
    }
    if (step === 'generate') {
      return runGenerate(db, id, body.painPointIds ?? []);
    }
    if (step === 'improve') {
      if (!body.collateralId || !body.feedback) {
        log.warn('Missing collateralId or feedback for improve step', { workflowId: id });
        return c.json({ error: 'collateralId and feedback are required' }, 400);
      }
      return runImprove(db, id, body.collateralId, body.feedback);
    }
    if (step === 'export') {
      const target = body.target ?? 'markdown';
      if (!isValidExportTarget(target)) {
        log.warn('Invalid export target', { workflowId: id, target });
        return c.json(
          { error: `Invalid export target. Must be one of: ${VALID_EXPORT_TARGETS.join(', ')}` },
          400
        );
      }
      return runExport(db, id, userId, target);
    }

    log.warn('Invalid step', { workflowId: id, step });
    return c.json({ error: 'Invalid step' }, 400);
  });

  // ─── Update company name ────────────────────────────────────────────
  router.patch('/workflows/:id/company', async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    const body = (await c.req.json().catch(() => ({}))) as { companyName?: string };

    const companyName =
      typeof body.companyName === 'string' ? body.companyName.trim().slice(0, 200) : null;

    const wf = await db.query.workbenchSession.findFirst({
      where: and(eq(workbenchSession.id, id), eq(workbenchSession.userId, userId)),
    });
    if (!wf) return c.json({ error: 'Workflow not found' }, 404);

    await db.update(workbenchSession).set({ companyName }).where(eq(workbenchSession.id, id));

    log.info('Company name updated', { workflowId: id, companyName });
    return c.json({ id, companyName });
  });

  // ─── Granola helper ─────────────────────────────────────────────────
  router.get('/recent-calls', async (c) => {
    if (!granolaClient) {
      return c.json({ error: 'Granola API not configured' }, 503);
    }
    try {
      const calls = await (granolaClient as GranolaClient).getRecentNotes(3);
      return c.json({ calls });
    } catch (err) {
      log.error('Granola fetch failed', { error: String(err) });
      return c.json({ error: 'Failed to fetch recent calls from Granola' }, 502);
    }
  });

  return router;
}

// ─── Step helpers ───────────────────────────────────────────────────

function deriveCurrentStep(status: string): StepName {
  const map: Record<string, StepName> = {
    analyzing: 'analyze',
    reviewing: 'generate',
    improving: 'improve',
    exporting: 'export',
    done: 'export',
  };
  return map[status] ?? 'intake';
}

async function runAnalyze(db: any, id: string, userId: string, feedback?: string) {
  log.info('Starting analyze step', { workflowId: id, hasFeedback: Boolean(feedback) });

  const wf = await db.query.workbenchSession.findFirst({
    where: and(eq(workbenchSession.id, id), eq(workbenchSession.userId, userId)),
  });
  const tx = await db.query.transcript.findFirst({
    where: eq(transcript.id, wf.transcriptId),
  });

  log.info('Extracting pain points', { workflowId: id, transcriptLength: tx.content.length });
  const { painPoints: extracted, companyName } = await extractPainPoints(id, tx.content, feedback);
  log.info('Pain points extracted', { workflowId: id, count: extracted.length, companyName });

  const inserted =
    extracted.length > 0 ? await db.insert(painPoint).values(extracted).returning() : [];

  const sessionUpdate: Record<string, unknown> = { status: 'reviewing' };
  if (companyName) sessionUpdate.companyName = companyName;
  await db.update(workbenchSession).set(sessionUpdate).where(eq(workbenchSession.id, id));

  log.info('Analyze step complete', { workflowId: id, insertedCount: inserted.length });

  return Response.json({
    id,
    status: 'reviewing',
    currentStep: 'generate',
    steps: {
      analyze: { completed: true, painPoints: inserted.map(serializePainPoint) },
    },
  });
}

async function runGenerate(db: any, id: string, painPointIds: string[]) {
  log.info('Starting generate step', { workflowId: id, painPointCount: painPointIds.length });

  const [points, wf] = await Promise.all([
    db.query.painPoint.findMany({ where: inArray(painPoint.id, painPointIds) }),
    db.query.workbenchSession.findFirst({ where: eq(workbenchSession.id, id) }),
  ]);

  const tx = wf?.transcriptId
    ? await db.query.transcript.findFirst({ where: eq(transcript.id, wf.transcriptId) })
    : null;
  const transcriptContent: string = tx?.content ?? '';

  await db.update(painPoint).set({ selected: true }).where(inArray(painPoint.id, painPointIds));

  const COLLATERAL_TYPES = ['email', 'linkedin', 'one-pager', 'battlecard'] as const;

  const results = await Promise.allSettled(
    points.flatMap((p: any) =>
      COLLATERAL_TYPES.map((type) =>
        generateCollateralWithLLM(id, transcriptContent, p, type).then(({ title, body }) => ({
          painPointId: p.id,
          type,
          title,
          body,
          status: 'draft',
          version: 1,
        }))
      )
    )
  );

  const generated = results.flatMap((r) => {
    if (r.status === 'fulfilled') return [r.value];
    log.error('Collateral generation failed for one item', { workflowId: id, error: String(r.reason) });
    return [];
  });

  const inserted =
    generated.length > 0 ? await db.insert(collateralItem).values(generated).returning() : [];

  await db.update(workbenchSession).set({ status: 'improving' }).where(eq(workbenchSession.id, id));

  log.info('Generate step complete', { workflowId: id, collateralCount: inserted.length });

  return Response.json({
    id,
    status: 'improving',
    currentStep: 'improve',
    steps: {
      generate: { completed: true, collateral: inserted.map(serializeCollateral) },
    },
  });
}

async function runImprove(db: any, id: string, collateralId: string, feedback: string) {
  log.info('Starting improve step', {
    workflowId: id,
    collateralId,
    feedbackLength: feedback.length,
  });

  const item = await db.query.collateralItem.findFirst({
    where: eq(collateralItem.id, collateralId),
  });
  if (!item) {
    log.warn('Collateral not found for improve', { workflowId: id, collateralId });
    return Response.json({ error: 'Collateral not found' }, { status: 404 });
  }

  const nextVersion = item.version + 1;
  const [improvedTitle, improvedBody] = await Promise.all([
    refineFeedbackWithLLM(item.title, feedback, item.type),
    refineFeedbackWithLLM(item.body, feedback, item.type),
  ]);

  await db.insert(collateralVersion).values({
    collateralId: item.id,
    title: item.title,
    body: item.body,
    version: item.version,
  });

  const updated = await db
    .update(collateralItem)
    .set({ title: improvedTitle, body: improvedBody, version: nextVersion })
    .where(eq(collateralItem.id, collateralId))
    .returning();

  const row = updated[0];
  log.info('Improve step complete', { workflowId: id, collateralId, newVersion: nextVersion });

  return Response.json({
    id,
    status: 'improving',
    currentStep: 'improve',
    steps: {
      improve: { completed: true, collateral: serializeCollateral(row) },
    },
  });
}

async function runExport(db: any, id: string, userId: string, target: string) {
  log.info('Starting export step', { workflowId: id, target });

  const wf = await db.query.workbenchSession.findFirst({
    where: and(eq(workbenchSession.id, id), eq(workbenchSession.userId, userId)),
  });
  if (!wf) {
    log.warn('Workflow not found for export', { workflowId: id });
    return Response.json({ error: 'Workflow not found' }, { status: 404 });
  }

  const points = await db.query.painPoint.findMany({
    where: eq(painPoint.sessionId, id),
  });
  const pointIds = points.map((p: any) => p.id);

  const allCollateral =
    pointIds.length > 0
      ? await db.query.collateralItem.findMany({
          where: inArray(collateralItem.painPointId, pointIds),
        })
      : [];

  if (allCollateral.length === 0) {
    log.warn('No collateral to export', { workflowId: id });
    return Response.json({ error: 'No collateral to export' }, { status: 400 });
  }

  const assembled = assembleExport(allCollateral, target);

  await db.update(workbenchSession).set({ status: 'done' }).where(eq(workbenchSession.id, id));

  log.info('Export step complete', {
    workflowId: id,
    target,
    collateralCount: allCollateral.length,
  });

  return Response.json({
    id,
    status: 'done',
    currentStep: 'export',
    export: {
      target,
      content: assembled,
      collateral: allCollateral.map(serializeCollateral),
    },
  });
}

// ─── Serialization helpers ──────────────────────────────────────────

function serializePainPoint(p: any) {
  return {
    id: p.id,
    workflowId: p.sessionId,
    severity: p.severity,
    context: p.context,
    quote: p.quote,
    selected: p.selected,
    createdAt:
      typeof p.createdAt === 'string'
        ? p.createdAt
        : (p.createdAt?.toISOString?.() ?? new Date().toISOString()),
  };
}

function serializeCollateral(c: any) {
  return {
    id: c.id,
    painPointId: c.painPointId,
    type: c.type,
    title: c.title,
    body: c.body,
    status: c.status,
    version: c.version,
    createdAt:
      typeof c.createdAt === 'string'
        ? c.createdAt
        : (c.createdAt?.toISOString?.() ?? new Date().toISOString()),
    updatedAt:
      typeof c.updatedAt === 'string'
        ? c.updatedAt
        : (c.updatedAt?.toISOString?.() ?? new Date().toISOString()),
  };
}

// ─── Content generation helpers ─────────────────────────────────────

function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, '');
}

function isValidExportTarget(target: string): target is ExportTarget {
  return (VALID_EXPORT_TARGETS as unknown as string[]).includes(target);
}

function escapeForCsv(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function escapeForMarkdown(text: string): string {
  return text.replace(/[*#`[\]\\]/g, '\\$&');
}

function assembleExport(collateral: any[], target: string): string {
  if (target === 'json') {
    return JSON.stringify(collateral, null, 2);
  }

  if (target === 'csv') {
    const header = 'Type,Title,Body';
    const rows = collateral.map((c) =>
      [escapeForCsv(c.type), escapeForCsv(c.title), escapeForCsv(c.body)].join(',')
    );
    return [header, ...rows].join('\n');
  }

  return collateral
    .map((c) => `## ${escapeForMarkdown(c.title)}\n\n${c.body}\n\n*(${c.type} collateral)*`)
    .join('\n\n---\n\n');
}
