import { Hono } from 'hono';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getLogger } from '@intx/log';
import { resolveCredentialRequirement, schema as intxSchema } from '@intx/db';
import type { DB } from '@intx/db';
import type { InferenceSource } from '@intx/types/runtime';
import { workflowRegistry } from '@workbench/workflow-core';
import { collateralGenerationWorkflow } from '@workbench/gtm-workflows';
import { workflowRun, transcript, painPoint, artifact, artifactVersion } from '../db/schema';
import {
  isGranolaConfigured,
  getNoteWithTranscript,
  getRecentNotes,
  transcriptToText,
} from '../lib/granola';
import { extractPainPoints } from '../lib/extraction';
import { refineFeedbackWithLLM } from '../lib/feedback';
import { generateCollateralWithLLM } from '../lib/generation';
import { decryptSecret } from '@workbench/hub-crypto';
import { getConfig } from '../config';
import { randomUUID } from 'node:crypto';
const log = getLogger(['api', 'workflow']);

workflowRegistry.register(collateralGenerationWorkflow);

const STEP_ORDER = ['intake', 'analyze', 'generate', 'improve', 'export'] as const;
type StepName = (typeof STEP_ORDER)[number];

const CONFIGURABLE_STEPS = ['analyze', 'generate', 'improve'] as const;
type ConfigurableStep = (typeof CONFIGURABLE_STEPS)[number];

export interface StepConfig {
  agentId?: string;
  toolIds?: string[];
}

export interface WorkflowStepConfig {
  analyze?: StepConfig;
  generate?: StepConfig;
  improve?: StepConfig;
}

const VALID_EXPORT_TARGETS = ['markdown', 'csv', 'json'] as const;
type ExportTarget = (typeof VALID_EXPORT_TARGETS)[number];

import type { UserContext } from '@workbench/workflow-core';

interface WorkflowInput {
  transcriptId?: string;
  transcriptSource?: string;
  companyName?: string;
  stepConfig?: WorkflowStepConfig;
}

const WORKFLOW_LLM_REQUIREMENT = {
  providerName: 'openai-compatible',
  source: 'tenant' as const,
  name: 'Myra LLM',
};

async function resolveWorkflowInferenceSource(
  db: DB['db'],
  tenantId: string
): Promise<InferenceSource | null> {
  const resolved = await resolveCredentialRequirement(
    db,
    tenantId,
    WORKFLOW_LLM_REQUIREMENT,
    null,
    null
  );
  if (!resolved) return null;

  const providerRow = await db.query.provider.findFirst({
    where: eq(intxSchema.provider.id, resolved.providerId),
  });
  if (!providerRow) return null;

  const meta = providerRow.metadata as { baseURL?: string; model?: string } | null;
  if (!meta?.baseURL || !meta.model) return null;

  const { credentialKeys } = getConfig();
  const apiKey = decryptSecret(credentialKeys, tenantId, resolved.secret);

  return {
    id: `workflow-llm-${randomUUID()}`,
    provider: providerRow.plugin,
    baseURL: meta.baseURL,
    apiKey,
    model: meta.model,
  };
}

async function getUserContext(db: DB['db'], userId: string): Promise<UserContext | null> {
  const personalTenant = await db.query.tenant.findFirst({
    where: eq(intxSchema.tenant.slug, `user-${userId}`),
  });

  if (!personalTenant) {
    return null;
  }

  const principal = await db.query.principal.findFirst({
    where: and(
      eq(intxSchema.principal.tenantId, personalTenant.id),
      eq(intxSchema.principal.kind, 'user'),
      eq(intxSchema.principal.refId, userId)
    ),
  });

  if (!principal) {
    log.error('Principal not found for user', {
      userId,
      tenantId: personalTenant.id,
    });
    return null;
  }

  return {
    tenantId: personalTenant.id,
    principalId: principal.id,
  };
}

function validateWorkflowInput(
  workflowKind: string,
  input: Record<string, unknown>
): { valid: true } | { valid: false; error: string } {
  const workflow = workflowRegistry.get(workflowKind);
  if (!workflow) {
    return { valid: false, error: `Workflow not found: ${workflowKind}` };
  }

  if (!workflow.inputSchema) {
    return { valid: true };
  }

  // inputSchema is a JSON schema object. Validate required fields explicitly
  // rather than passing to arktype, which uses its own definition syntax.
  const schema = workflow.inputSchema as { required?: string[] };
  const required = Array.isArray(schema.required) ? schema.required : [];
  const missing = required.filter((key) => input[key] === undefined || input[key] === null);
  if (missing.length > 0) {
    return {
      valid: false,
      error: `Invalid workflow input: missing required fields: ${missing.join(', ')}`,
    };
  }
  return { valid: true };
}

export function createWorkflowRouter(db: DB['db']): Hono<{ Variables: { userId: string } }> {
  const router = new Hono<{ Variables: { userId: string } }>();

  // ─── List available workflow types ───────────────────────────────
  router.get('/workflows/types', async (c) => {
    const types = workflowRegistry.list();
    return c.json(types);
  });

  // ─── Create workflow (intake) ─────────────────────────────────────
  router.post('/workflows', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      transcript?: string;
      granolaId?: string;
      source?: string;
      workflowKind?: string;
    };

    const workflowKind = body.workflowKind;
    if (!workflowKind) {
      log.warn('Workflow kind is required');
      return c.json({ error: 'workflowKind is required' }, 400);
    }
    if (!workflowRegistry.isValid(workflowKind)) {
      log.warn('Invalid workflow kind', { workflowKind });
      return c.json({ error: `Invalid workflow kind: ${workflowKind}` }, 400);
    }

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
      if (!isGranolaConfigured()) {
        log.warn('Granola API not configured');
        return c.json({ error: 'Granola API not configured' }, 503);
      }
      try {
        const note = await getNoteWithTranscript(body.granolaId);
        content = transcriptToText(note) || note.summary || note.title || '';
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

    const userContext = await getUserContext(db, userId);
    if (!userContext) {
      log.warn('User context not found', { userId });
      return c.json({ error: 'User context not found' }, 400);
    }

    const [txRow] = await db
      .insert(transcript)
      .values({ content, source: body.source })
      .returning();

    const workflowInput = { transcriptId: txRow.id, transcriptSource: body.source };
    const inputValidation = validateWorkflowInput(workflowKind, workflowInput);
    if (!inputValidation.valid) {
      log.warn('Workflow input validation failed', {
        workflowKind,
        error: inputValidation.error,
      });
      return c.json({ error: inputValidation.error }, 400);
    }

    const [wfRow] = await db
      .insert(workflowRun)
      .values({
        tenantId: userContext.tenantId,
        principalId: userContext.principalId,
        kind: workflowKind,
        status: 'pending',
        input: workflowInput,
      })
      .returning();

    log.info('Workflow created', {
      workflowId: wfRow.id,
      transcriptId: txRow.id,
      kind: wfRow.kind,
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

    const userContext = await getUserContext(db, userId);
    if (!userContext) {
      log.warn('User context not found', { userId });
      return c.json([]);
    }

    const requestedTenantId = c.req.query('tenantId');
    let workflowPrincipalId = userContext.principalId;

    if (requestedTenantId) {
      const requestedPrincipal = await db.query.principal.findFirst({
        where: and(
          eq(intxSchema.principal.tenantId, requestedTenantId),
          eq(intxSchema.principal.kind, 'user'),
          eq(intxSchema.principal.refId, userId)
        ),
      });

      if (!requestedPrincipal) {
        log.warn('User requested workflows for inaccessible tenant', { userId, requestedTenantId });
        return c.json({ error: 'Tenant not accessible' }, 403);
      }

      workflowPrincipalId = requestedPrincipal.id;
    }

    const sessions = await db.query.workflowRun.findMany({
      where: requestedTenantId
        ? and(
            eq(workflowRun.tenantId, requestedTenantId),
            eq(workflowRun.principalId, workflowPrincipalId)
          )
        : eq(workflowRun.principalId, workflowPrincipalId),
      orderBy: [desc(workflowRun.createdAt)],
      limit: 50,
    });

    const rows = await Promise.all(
      sessions.map(async (s: (typeof sessions)[number]) => {
        const transcriptId = (s.input as WorkflowInput)?.transcriptId;
        const tx = transcriptId
          ? await db.query.transcript.findFirst({ where: eq(transcript.id, transcriptId) })
          : null;
        const points = await db.query.painPoint.findMany({
          where: eq(painPoint.sessionId, s.id),
          columns: { id: true, context: true },
        });
        return {
          id: s.id,
          status: s.status,
          createdAt: s.createdAt,
          transcriptId: transcriptId ?? null,
          companyName: (s.input as WorkflowInput)?.companyName ?? null,
          transcriptPreview: tx?.content?.slice(0, 80) ?? null,
          painPointCount: points.length,
          firstPainPoint: points[0]?.context ?? null,
        };
      })
    );

    return c.json(rows);
  });

  // ─── List artifacts (aggregate across the user's sessions) ──────────
  router.get('/artifacts', async (c) => {
    const userId = c.get('userId');

    const userContext = await getUserContext(db, userId);
    if (!userContext) {
      log.warn('User context not found', { userId });
      return c.json([]);
    }

    // Scope by principalId. Tenant-path scoping is CL-1246 and intentionally out of scope here.
    const sessions = await db.query.workflowRun.findMany({
      where: eq(workflowRun.principalId, userContext.principalId),
      orderBy: [desc(workflowRun.createdAt)],
      limit: 50,
    });

    if (sessions.length === 0) {
      return c.json([]);
    }

    const sessionById = new Map<string, (typeof sessions)[number]>(
      sessions.map((s: (typeof sessions)[number]) => [s.id, s])
    );

    const artifacts = await db.query.artifact.findMany({
      where: inArray(
        artifact.sessionId,
        sessions.map((s: (typeof sessions)[number]) => s.id)
      ),
      orderBy: [desc(artifact.updatedAt)],
    });

    const rows = artifacts.map((a: any) => {
      const session = sessionById.get(a.sessionId);
      return {
        ...serializeArtifact(a),
        sessionName: (session?.input as WorkflowInput)?.companyName ?? null,
        sessionStatus: session?.status ?? null,
      };
    });

    return c.json(rows);
  });

  // ─── Read workflow ──────────────────────────────────────────────────
  router.get('/workflows/:id', async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    log.info('Fetching workflow', { workflowId: id });

    const userContext = await getUserContext(db, userId);
    if (!userContext) {
      log.warn('User context not found', { userId });
      return c.json({ error: 'Workflow not found' }, 404);
    }

    const wf = await db.query.workflowRun.findFirst({
      where: and(eq(workflowRun.id, id), eq(workflowRun.principalId, userContext.principalId)),
    });
    if (!wf) {
      log.warn('Workflow not found', { workflowId: id });
      return c.json({ error: 'Workflow not found' }, 404);
    }

    const transcriptId = (wf.input as WorkflowInput)?.transcriptId;
    const tx = transcriptId
      ? await db.query.transcript.findFirst({ where: eq(transcript.id, transcriptId) })
      : null;

    const points = await db.query.painPoint.findMany({
      where: eq(painPoint.sessionId, id),
    });

    const allArtifacts = await db.query.artifact.findMany({
      where: eq(artifact.sessionId, id),
    });

    const currentStep = deriveCurrentStep(wf.status);
    log.info('Workflow fetched', {
      workflowId: id,
      currentStep,
      painPointsCount: points.length,
      artifactCount: allArtifacts.length,
    });

    const stepConfig: WorkflowStepConfig = (wf.input as WorkflowInput)?.stepConfig ?? {};

    return c.json({
      id,
      status: wf.status,
      currentStep,
      companyName: (wf.input as WorkflowInput)?.companyName ?? null,
      stepConfig,
      steps: {
        intake: { completed: true, transcriptId: transcriptId ?? null, transcript: tx?.content },
        analyze: {
          completed: wf.status !== 'pending',
          painPoints: points.map(serializePainPoint),
        },
        generate: {
          completed: allArtifacts.length > 0,
          artifacts: allArtifacts.map(serializeArtifact),
        },
        improve: { completed: allArtifacts.some((a: { version: number }) => a.version > 1) },
        export: { completed: wf.status === 'done' },
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
      artifactId?: string;
      feedback?: string;
      target?: string;
    };

    log.info('Running step', { workflowId: id, step: body.step });

    const userContext = await getUserContext(db, userId);
    if (!userContext) {
      log.warn('User context not found', { userId });
      return c.json({ error: 'Workflow not found' }, 404);
    }

    const wf = await db.query.workflowRun.findFirst({
      where: and(eq(workflowRun.id, id), eq(workflowRun.principalId, userContext.principalId)),
    });
    if (!wf) {
      log.warn('Workflow not found for step', { workflowId: id });
      return c.json({ error: 'Workflow not found' }, 404);
    }

    const step = body.step ?? deriveCurrentStep(wf.status);

    if (step === 'analyze' || step === 'generate' || step === 'improve') {
      const source = await resolveWorkflowInferenceSource(db, userContext.tenantId);
      if (!source) {
        log.warn('No workflow LLM credential configured', { tenantId: userContext.tenantId });
        return c.json(
          {
            error:
              'No LLM credential configured for this workspace. Please add one in Settings.',
          },
          400
        );
      }

      if (step === 'analyze') {
        return runAnalyze(db, id, userContext, source, body.feedback);
      }
      if (step === 'generate') {
        return runGenerate(db, id, body.painPointIds ?? [], userContext.principalId, source);
      }
      // step === 'improve'
      if (!body.artifactId || !body.feedback) {
        log.warn('Missing artifactId or feedback for improve step', { workflowId: id });
        return c.json({ error: 'artifactId and feedback are required' }, 400);
      }
      return runImprove(db, id, body.artifactId, body.feedback, userContext.principalId, source);
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
      return runExport(db, id, userContext, target);
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

    const userContext = await getUserContext(db, userId);
    if (!userContext) {
      log.warn('User context not found', { userId });
      return c.json({ error: 'Workflow not found' }, 404);
    }

    const wf = await db.query.workflowRun.findFirst({
      where: and(eq(workflowRun.id, id), eq(workflowRun.principalId, userContext.principalId)),
    });
    if (!wf) return c.json({ error: 'Workflow not found' }, 404);

    const updatedInput: WorkflowInput = { ...(wf.input as WorkflowInput) };
    if (companyName !== null) updatedInput.companyName = companyName;
    await db
      .update(workflowRun)
      .set({ input: updatedInput as Record<string, unknown> })
      .where(eq(workflowRun.id, id));

    log.info('Company name updated', { workflowId: id, companyName });
    return c.json({ id, companyName });
  });

  // ─── Update step config ─────────────────────────────────────────────
  router.patch('/workflows/:id/step-config', async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    const body = (await c.req.json().catch(() => ({}))) as { stepConfig?: unknown };

    if (!body.stepConfig || typeof body.stepConfig !== 'object' || Array.isArray(body.stepConfig)) {
      log.warn('Missing or invalid stepConfig in request body', { workflowId: id });
      return c.json({ error: 'stepConfig object is required' }, 400);
    }

    // Validate that all keys are configurable step names
    const keys = Object.keys(body.stepConfig as object);
    const invalidKeys = keys.filter((k) => !CONFIGURABLE_STEPS.includes(k as ConfigurableStep));
    if (invalidKeys.length > 0) {
      log.warn('stepConfig contains unknown step keys', { workflowId: id, invalidKeys });
      return c.json(
        {
          error: `Unknown step keys: ${invalidKeys.join(', ')}. Valid steps: ${CONFIGURABLE_STEPS.join(', ')}`,
        },
        400
      );
    }

    // Validate per-step structure
    const rawConfig = body.stepConfig as Record<string, unknown>;
    const validatedConfig: WorkflowStepConfig = {};
    for (const step of CONFIGURABLE_STEPS) {
      const stepVal = rawConfig[step];
      if (stepVal === undefined) continue;
      if (typeof stepVal !== 'object' || stepVal === null || Array.isArray(stepVal)) {
        return c.json({ error: `stepConfig.${step} must be an object` }, 400);
      }
      const s = stepVal as Record<string, unknown>;
      const agentId = s['agentId'] !== undefined ? s['agentId'] : undefined;
      const toolIds = s['toolIds'] !== undefined ? s['toolIds'] : undefined;
      if (agentId !== undefined && typeof agentId !== 'string') {
        return c.json({ error: `stepConfig.${step}.agentId must be a string` }, 400);
      }
      if (
        toolIds !== undefined &&
        (!Array.isArray(toolIds) || !toolIds.every((t) => typeof t === 'string'))
      ) {
        return c.json({ error: `stepConfig.${step}.toolIds must be an array of strings` }, 400);
      }
      const entry: StepConfig = {};
      if (typeof agentId === 'string') entry.agentId = agentId;
      if (Array.isArray(toolIds)) entry.toolIds = toolIds as string[];
      validatedConfig[step] = entry;
    }

    const userContext = await getUserContext(db, userId);
    if (!userContext) {
      log.warn('User context not found', { userId });
      return c.json({ error: 'User context not found' }, 400);
    }

    const wf = await db.query.workflowRun.findFirst({
      where: and(eq(workflowRun.id, id), eq(workflowRun.principalId, userContext.principalId)),
    });
    if (!wf) {
      log.warn('Workflow not found for step-config update', { workflowId: id });
      return c.json({ error: 'Workflow not found' }, 404);
    }

    // Validate that any provided agentId belongs to the user's tenant
    const agentIds = Object.values(validatedConfig)
      .map((s) => s?.agentId)
      .filter((id): id is string => typeof id === 'string');
    if (agentIds.length > 0) {
      const instances = await db.query.agentInstance.findMany({
        where: and(
          inArray(intxSchema.agentInstance.id, agentIds),
          eq(intxSchema.agentInstance.tenantId, userContext.tenantId)
        ),
      });
      const foundIds = new Set(instances.map((i) => i.id));
      const unauthorized = agentIds.filter((aid) => !foundIds.has(aid));
      if (unauthorized.length > 0) {
        log.warn('agentId not found in tenant', { workflowId: id, unauthorized });
        return c.json({ error: 'One or more agentIds not found' }, 400);
      }
    }

    const updatedInput: WorkflowInput = {
      ...(wf.input as WorkflowInput),
      stepConfig: validatedConfig,
    };
    await db
      .update(workflowRun)
      .set({ input: updatedInput as Record<string, unknown> })
      .where(eq(workflowRun.id, id));

    log.info('Step config updated', { workflowId: id, steps: Object.keys(validatedConfig) });
    return c.json({ id, stepConfig: validatedConfig });
  });

  // ─── Granola helper ─────────────────────────────────────────────────
  router.get('/recent-calls', async (c) => {
    if (!isGranolaConfigured()) {
      return c.json({ error: 'Granola API not configured' }, 503);
    }
    try {
      const calls = await getRecentNotes(3);
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
    pending: 'analyze',
    running: 'generate',
    done: 'export',
    failed: 'intake',
  };
  return map[status] ?? 'intake';
}

async function runAnalyze(
  db: DB['db'],
  id: string,
  userContext: UserContext,
  source: InferenceSource,
  feedback?: string
) {
  log.info('Starting analyze step', { workflowId: id, hasFeedback: Boolean(feedback) });

  const wf = await db.query.workflowRun.findFirst({
    where: and(eq(workflowRun.id, id), eq(workflowRun.principalId, userContext.principalId)),
  });

  const transcriptId = (wf?.input as WorkflowInput)?.transcriptId;
  const tx = transcriptId
    ? await db.query.transcript.findFirst({ where: eq(transcript.id, transcriptId) })
    : null;

  if (!tx) {
    log.error('Transcript not found for analyze', { workflowId: id, transcriptId });
    return Response.json({ error: 'Transcript not found' }, { status: 400 });
  }

  log.info('Extracting pain points', { workflowId: id, transcriptLength: tx.content.length });
  const { painPoints: extracted, companyName } = await extractPainPoints(
    id,
    tx.content,
    feedback,
    source
  );
  log.info('Pain points extracted', { workflowId: id, count: extracted.length, companyName });

  await db.delete(painPoint).where(eq(painPoint.sessionId, id));

  const inserted =
    extracted.length > 0 ? await db.insert(painPoint).values(extracted).returning() : [];

  const updatedInput: WorkflowInput = { ...(wf?.input as WorkflowInput) };
  if (companyName) updatedInput.companyName = companyName;
  await db
    .update(workflowRun)
    .set({ status: 'running', input: updatedInput as Record<string, unknown> })
    .where(eq(workflowRun.id, id));

  log.info('Analyze step complete', { workflowId: id, insertedCount: inserted.length });

  return Response.json({
    id,
    status: 'running',
    currentStep: 'generate',
    steps: {
      analyze: { completed: true, painPoints: inserted.map(serializePainPoint) },
    },
  });
}

async function runGenerate(
  db: DB['db'],
  id: string,
  painPointIds: string[],
  principalId: string,
  source: InferenceSource
) {
  const authorId = principalId;
  log.info('Starting generate step', { workflowId: id, painPointCount: painPointIds.length });

  const [points, wf] = await Promise.all([
    db.query.painPoint.findMany({
      where: and(inArray(painPoint.id, painPointIds), eq(painPoint.sessionId, id)),
    }),
    db.query.workflowRun.findFirst({
      where: and(eq(workflowRun.id, id), eq(workflowRun.principalId, principalId)),
    }),
  ]);

  if (!wf) {
    log.warn('Workflow not found for generate', { workflowId: id });
    return Response.json({ error: 'Workflow not found' }, { status: 404 });
  }

  const transcriptId = (wf.input as WorkflowInput)?.transcriptId;
  const tx = transcriptId
    ? await db.query.transcript.findFirst({ where: eq(transcript.id, transcriptId) })
    : null;
  const transcriptContent: string = tx?.content ?? '';

  await db
    .update(painPoint)
    .set({ selected: true })
    .where(and(inArray(painPoint.id, painPointIds), eq(painPoint.sessionId, id)));

  const ARTIFACT_KINDS = ['email', 'linkedin', 'one-pager', 'battlecard'] as const;

  const results = await Promise.allSettled(
    points.flatMap((p: any) =>
      ARTIFACT_KINDS.map((kind) =>
        generateCollateralWithLLM(id, transcriptContent, p, kind, source).then(
          ({ title, body }) => ({
            sessionId: id,
            painPointId: p.id,
            kind,
            title,
            content: body,
            status: 'draft',
            version: 1,
          })
        )
      )
    )
  );

  const generated = results.flatMap((r) => {
    if (r.status === 'fulfilled') return [r.value];
    log.error('Artifact generation failed for one item', {
      workflowId: id,
      error: String(r.reason),
    });
    return [];
  });

  // Insert artifacts and their initial version rows atomically, so an artifact
  // can never exist without a matching v1 history row.
  const inserted =
    generated.length > 0
      ? await db.transaction(async (trx: any) => {
          const rows = await trx.insert(artifact).values(generated).returning();
          await trx.insert(artifactVersion).values(
            rows.map((a: any) => ({
              artifactId: a.id,
              version: a.version,
              title: a.title,
              content: a.content,
              authorId,
            }))
          );
          return rows;
        })
      : [];

  await db.update(workflowRun).set({ status: 'running' }).where(eq(workflowRun.id, id));

  log.info('Generate step complete', { workflowId: id, artifactCount: inserted.length });

  return Response.json({
    id,
    status: 'running',
    currentStep: 'improve',
    steps: {
      generate: { completed: true, artifacts: inserted.map(serializeArtifact) },
    },
  });
}

async function runImprove(
  db: DB['db'],
  id: string,
  artifactId: string,
  feedback: string,
  authorId: string,
  source: InferenceSource
) {
  log.info('Starting improve step', {
    workflowId: id,
    artifactId,
    feedbackLength: feedback.length,
  });

  // Scope to the session from the route (already verified to belong to the
  // caller) so a user cannot mutate another session's artifact by id.
  const item = await db.query.artifact.findFirst({
    where: and(eq(artifact.id, artifactId), eq(artifact.sessionId, id)),
  });
  if (!item) {
    log.warn('Artifact not found for improve', { workflowId: id, artifactId });
    return Response.json({ error: 'Artifact not found' }, { status: 404 });
  }

  const nextVersion = item.version + 1;
  const [improvedTitle, improvedContent] = await Promise.all([
    refineFeedbackWithLLM(item.title, feedback, item.kind, source),
    refineFeedbackWithLLM(item.content, feedback, item.kind, source),
  ]);

  // Update the artifact and append its new version row atomically, so the live
  // version always has a matching history row.
  const row = await db.transaction(async (trx: any) => {
    const updated = await trx
      .update(artifact)
      .set({ title: improvedTitle, content: improvedContent, version: nextVersion })
      .where(and(eq(artifact.id, artifactId), eq(artifact.sessionId, id)))
      .returning();
    await trx.insert(artifactVersion).values({
      artifactId: item.id,
      version: nextVersion,
      title: improvedTitle,
      content: improvedContent,
      authorId,
    });
    return updated[0];
  });
  log.info('Improve step complete', { workflowId: id, artifactId, newVersion: nextVersion });

  return Response.json({
    id,
    status: 'improving',
    currentStep: 'improve',
    steps: {
      improve: { completed: true, artifact: serializeArtifact(row) },
    },
  });
}

async function runExport(
  db: DB['db'],
  id: string,
  userContext: UserContext,
  target: string
) {
  log.info('Starting export step', { workflowId: id, target });

  const wf = await db.query.workflowRun.findFirst({
    where: and(eq(workflowRun.id, id), eq(workflowRun.principalId, userContext.principalId)),
  });
  if (!wf) {
    log.warn('Workflow not found for export', { workflowId: id });
    return Response.json({ error: 'Workflow not found' }, { status: 404 });
  }

  const allArtifacts = await db.query.artifact.findMany({
    where: eq(artifact.sessionId, id),
  });

  if (allArtifacts.length === 0) {
    log.warn('No artifacts to export', { workflowId: id });
    return Response.json({ error: 'No artifacts to export' }, { status: 400 });
  }

  const assembled = assembleExport(allArtifacts, target);

  await db.update(workflowRun).set({ status: 'done' }).where(eq(workflowRun.id, id));

  log.info('Export step complete', {
    workflowId: id,
    target,
    artifactCount: allArtifacts.length,
  });

  return Response.json({
    id,
    status: 'done',
    currentStep: 'export',
    export: {
      target,
      content: assembled,
      artifacts: allArtifacts.map(serializeArtifact),
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

function serializeArtifact(a: any) {
  return {
    id: a.id,
    sessionId: a.sessionId,
    parentId: a.parentId ?? null,
    painPointId: a.painPointId ?? null,
    kind: a.kind,
    title: a.title,
    content: a.content,
    status: a.status,
    version: a.version,
    createdAt:
      typeof a.createdAt === 'string'
        ? a.createdAt
        : (a.createdAt?.toISOString?.() ?? new Date().toISOString()),
    updatedAt:
      typeof a.updatedAt === 'string'
        ? a.updatedAt
        : (a.updatedAt?.toISOString?.() ?? new Date().toISOString()),
  };
}

// ─── Content generation helpers ─────────────────────────────────────

function isValidExportTarget(target: string): target is ExportTarget {
  return (VALID_EXPORT_TARGETS as unknown as string[]).includes(target);
}

function escapeForCsv(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function escapeForMarkdown(text: string): string {
  return text.replace(/[*#`[\]\\]/g, '\\$&');
}

function assembleExport(artifacts: any[], target: string): string {
  if (target === 'json') {
    return JSON.stringify(artifacts, null, 2);
  }

  if (target === 'csv') {
    const header = 'Kind,Title,Content';
    const rows = artifacts.map((a) =>
      [escapeForCsv(a.kind), escapeForCsv(a.title), escapeForCsv(a.content)].join(',')
    );
    return [header, ...rows].join('\n');
  }

  return artifacts
    .map((a) => `## ${escapeForMarkdown(a.title)}\n\n${a.content}\n\n*(${a.kind} artifact)*`)
    .join('\n\n---\n\n');
}
