import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import {
  workbenchSession,
  transcript,
  painPoint,
  collateralItem,
  collateralVersion,
} from '../db/schema';
import { GranolaClient } from '../lib/granola';
import { extractPainPoints } from '../lib/extraction';

const STEP_ORDER = ['intake', 'analyze', 'generate', 'improve', 'export'] as const;
type StepName = (typeof STEP_ORDER)[number];

export function createWorkflowRouter(db: any): Hono {
  const router = new Hono();

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

    if (!body.source || !['paste', 'granola'].includes(body.source)) {
      return c.json({ error: 'Invalid source' }, 400);
    }

    let content: string;

    if (body.source === 'paste') {
      if (!body.transcript || body.transcript.trim().length === 0) {
        return c.json({ error: 'transcript is required' }, 400);
      }
      if (body.transcript.length > 500000) {
        return c.json({ error: 'transcript exceeds maximum length' }, 413);
      }
      content = body.transcript;
    } else {
      if (!body.granolaId) {
        return c.json({ error: 'granolaId is required' }, 400);
      }
      if (!granolaClient) {
        return c.json({ error: 'Granola API not configured' }, 503);
      }
      try {
        const note = await (granolaClient as GranolaClient).getNoteWithTranscript(body.granolaId);
        content = note.transcript || note.title || '';
      } catch {
        return c.json({ error: 'Failed to fetch from Granola' }, 400);
      }
    }

    const [txRow] = await db
      .insert(transcript)
      .values({ content, source: body.source })
      .returning();
    const [wfRow] = await db
      .insert(workbenchSession)
      .values({ transcriptId: txRow.id, status: 'analyzing' })
      .returning();

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

  // ─── Read workflow ──────────────────────────────────────────────────
  router.get('/workflows/:id', async (c) => {
    const id = c.req.param('id');

    const wf = await db.query.workbenchSession.findFirst({
      where: eq(workbenchSession.id, id),
    });
    if (!wf) return c.json({ error: 'Workflow not found' }, 404);

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

    return c.json({
      id,
      status: wf.status,
      currentStep,
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
    const body = (await c.req.json().catch(() => ({}))) as {
      step?: StepName;
      painPointIds?: string[];
      collateralId?: string;
      feedback?: string;
    };

    const wf = await db.query.workbenchSession.findFirst({
      where: eq(workbenchSession.id, id),
    });
    if (!wf) return c.json({ error: 'Workflow not found' }, 404);

    const step = body.step ?? deriveCurrentStep(wf.status);

    if (step === 'analyze') {
      return runAnalyze(db, id, body.feedback);
    }
    if (step === 'generate') {
      return runGenerate(db, id, body.painPointIds ?? []);
    }
    if (step === 'improve') {
      if (!body.collateralId || !body.feedback) {
        return c.json({ error: 'collateralId and feedback are required' }, 400);
      }
      return runImprove(db, id, body.collateralId, body.feedback);
    }
    if (step === 'export') {
      return c.json({ error: 'Export not implemented' }, 501);
    }

    return c.json({ error: 'Invalid step' }, 400);
  });

  // ─── Granola helper ─────────────────────────────────────────────────
  router.get('/recent-calls', async (c) => {
    if (!granolaClient) {
      return c.json({ error: 'Granola API not configured' }, 503);
    }
    const calls = await (granolaClient as GranolaClient).getRecentNotes(3);
    return c.json({ calls });
  });

  return router;
}

// ─── Step helpers ───────────────────────────────────────────────────

function deriveCurrentStep(status: string): StepName {
  const map: Record<string, StepName> = {
    analyzing: 'analyze',
    reviewing: 'generate',
    generating: 'generate',
    improving: 'improve',
    exporting: 'export',
    done: 'export',
  };
  return map[status] ?? 'intake';
}

async function runAnalyze(db: any, id: string, feedback?: string) {
  const wf = await db.query.workbenchSession.findFirst({
    where: eq(workbenchSession.id, id),
  });
  const tx = await db.query.transcript.findFirst({
    where: eq(transcript.id, wf.transcriptId),
  });

  const extracted = await extractPainPoints(id, tx.content, feedback);
  const inserted =
    extracted.length > 0 ? await db.insert(painPoint).values(extracted).returning() : [];

  await db.update(workbenchSession).set({ status: 'reviewing' }).where(eq(workbenchSession.id, id));

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
  const points = await db.query.painPoint.findMany({
    where: inArray(painPoint.id, painPointIds),
  });

  await db.update(painPoint).set({ selected: true }).where(inArray(painPoint.id, painPointIds));

  const toInsert = points.map((p: any, i: number) => ({
    painPointId: p.id,
    type: i === 0 ? 'email' : 'linkedin',
    title: generateTitle(p.context),
    body: generateBody(p.context, p.quote),
    status: 'draft',
    version: 1,
  }));

  const inserted =
    toInsert.length > 0 ? await db.insert(collateralItem).values(toInsert).returning() : [];

  await db.update(workbenchSession).set({ status: 'reviewing' }).where(eq(workbenchSession.id, id));

  return Response.json({
    id,
    status: 'reviewing',
    currentStep: 'improve',
    steps: {
      generate: { completed: true, collateral: inserted.map(serializeCollateral) },
    },
  });
}

async function runImprove(db: any, id: string, collateralId: string, feedback: string) {
  const item = await db.query.collateralItem.findFirst({
    where: eq(collateralItem.id, collateralId),
  });
  if (!item) return Response.json({ error: 'Collateral not found' }, { status: 404 });

  const nextVersion = item.version + 1;
  const improvedTitle = applyFeedback(item.title, feedback);
  const improvedBody = applyFeedback(item.body, feedback);

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

  return Response.json({
    id,
    status: 'improving',
    currentStep: 'export',
    steps: {
      improve: { completed: true, collateral: serializeCollateral(row) },
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
    createdAt: typeof p.createdAt === 'string' ? p.createdAt : p.createdAt.toISOString(),
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
    createdAt: typeof c.createdAt === 'string' ? c.createdAt : c.createdAt.toISOString(),
    updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : c.updatedAt.toISOString(),
  };
}

// ─── Content generation helpers ─────────────────────────────────────

function generateTitle(context: string): string {
  const first = context.split(' ').slice(0, 6).join(' ');
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function generateBody(context: string, quote: string): string {
  return `${context}

Buyer said: "${quote}"

Use this phrasing in your next follow-up to show you heard them.`;
}

function applyFeedback(text: string, feedback: string): string {
  const lower = feedback.toLowerCase();
  if (lower.includes('shorter') || lower.includes('brief')) {
    return text.split('\n').slice(0, 2).join('\n');
  }
  if (lower.includes('punch') || lower.includes('sharp') || lower.includes('hook')) {
    return text + '\n\n(Hooked for impact)';
  }
  return text + '\n\n(Updated per feedback: ' + feedback + ')';
}
