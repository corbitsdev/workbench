import { Hono } from 'hono';
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, ne, or } from 'drizzle-orm';
import { getLogger } from '@intx/log';
import { schema as intxSchema } from '@intx/db';
import { fetchGammaTemplates } from '@workbench/tools-gamma';
import { workflowRegistry, flattenStepCredentialRequirements } from '@workbench/workflow-core';
import { isCredentialToolEntry, KNOWN_TOOLS } from '../lib/tool-registry';
import {
  collateralGenerationWorkflow,
  presentationGenerationWorkflow,
  isCollateralKind,
} from '@workbench/gtm-workflows';
import type { SessionService } from '@intx/hub-sessions';
import { generateKeyPair, createNodeCrypto } from '@intx/crypto-node';
import { generateId } from '@intx/hub-common';

export type SessionServiceDep = Pick<SessionService, 'sendUserMessage'>;
import type { HubDb } from '../db';
import {
  workflowRun,
  transcript,
  painPoint,
  artifact,
  artifactStatus,
  enabledWorkflow,
} from '../db/schema';
import { getNoteWithTranscript, getRecentNotes, transcriptToText } from '../lib/granola';
import { randomUUID } from 'node:crypto';
import { serializePainPoint, serializeArtifact } from '../serializers/workflow';
import { runAnalyze, runGenerate } from '../services/workflow-generation';
import {
  mapDbStatusToSessionStatus,
  getFirstRunnableStep,
  deriveCurrentStepForWorkflow,
  deriveWorkflowDisplayName,
  validateWorkflowInput,
  isWorkflowOwner,
  triggerStep,
  resolveStepInferenceSource,
  resolveAgentStepInferenceSource,
  resolveStepGranolaApiKey,
  resolveGranolaApiKey,
  validateAssignments,
  getUserContext,
  getRequestedUserContext,
  CONFIGURABLE_STEPS,
  type ConfigurableStep,
  type StepConfig,
  type WorkflowStepConfig,
  type WorkflowInput,
  type WorkflowAssignments,
} from '../services/workflow-orchestration';

const log = getLogger(['api', 'workflow']);

workflowRegistry.register(collateralGenerationWorkflow);
workflowRegistry.register(presentationGenerationWorkflow);

// Per-step output-token caps applied when a step has no explicit override.
// These are caps, not floors. Analyze is highest because reasoning models spend
// part of the budget on think blocks before emitting the pain-point JSON; a cap
// that is too low truncates the JSON and the step fails.
const DEFAULT_STEP_MAX_OUTPUT_TOKENS = {
  analyze: 16384,
  generate: 8192,
  improve: 4096,
} as const;

const MAX_STEP_OUTPUT_TOKENS = 65536;

// Resolve the recovery status for a workflow wedged mid-step. A run pinned in an
// in-progress status (because its inference hung) is moved back to the last
// stable state the user can act on: `generating` returns to `running` (pain
// points already exist, so the user re-selects and regenerates); `analyzing`
// has no usable partial output, so it goes to `failed`. Any other status is not
// stuck and is left untouched (returns null). See CL-1922.
export function resolveResetStatus(status: string): string | null {
  if (status === 'generating') return 'running';
  if (status === 'analyzing') return 'failed';
  return null;
}

export function createWorkflowRouter(
  db: HubDb,
  deps?: { sessionService?: SessionServiceDep }
): Hono<{ Variables: { userId: string } }> {
  const sessionService = deps?.sessionService;
  const router = new Hono<{ Variables: { userId: string } }>();

  // ─── List available workflow types ───────────────────────────────
  router.get('/workflows/types', async (c) => {
    const types = workflowRegistry.list();
    return c.json(types);
  });

  // ─── Workflow catalog ─────────────────────────────────────────────
  router.get('/workflows/catalog', async (c) => {
    const catalog = workflowRegistry.list().map((wt) => ({
      kind: wt.kind,
      name: wt.name,
      description: wt.description,
      steps: wt.steps,
      credentialRequirements: flattenStepCredentialRequirements(wt),
    }));
    return c.json(catalog);
  });

  // ─── Tool catalog (metadata for the install UI) ──────────────────────
  router.get('/workflows/tools', async (c) => {
    const tools = Object.entries(KNOWN_TOOLS).map(([name, entry]) => ({
      name,
      providerName: isCredentialToolEntry(entry) ? entry.providerName : 'workbench',
      description: entry.definition.description,
    }));
    return c.json(tools);
  });

  // ─── Gamma template registry ─────────────────────────────────────
  // Gamma has no list-templates API; we serve a workbench-owned curated registry.
  // Tenant-scoped persistence + an add-template flow land in CL-1874.
  router.get('/workflows/gamma/templates', (c) => {
    return c.json(fetchGammaTemplates());
  });

  // ─── List enabled workflows for tenant ───────────────────────────
  router.get('/workflows/enabled', async (c) => {
    const userId = c.get('userId');
    const requestedTenantId = c.req.query('tenantId');
    const { context: userContext, forbidden } = await getRequestedUserContext(
      db,
      userId,
      requestedTenantId
    );
    if (forbidden) {
      log.warn('User requested enabled workflows for inaccessible tenant', {
        userId,
        requestedTenantId,
      });
      return c.json({ error: 'Tenant not accessible' }, 403);
    }
    if (!userContext) {
      log.warn('User context not found', { userId });
      return c.json({ error: 'User context not found' }, 400);
    }

    const rows = await db.query.enabledWorkflow.findMany({
      where: and(
        eq(enabledWorkflow.tenantId, userContext.tenantId),
        or(
          eq(enabledWorkflow.principalId, userContext.principalId),
          isNull(enabledWorkflow.principalId)
        )
      ),
    });

    // Deduplicate by kind: a per-user row (principalId set) takes precedence
    // over a tenant-scoped row (principalId null) for the same kind.
    const byKind = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const existing = byKind.get(row.kind);
      if (!existing || existing.principalId === null) {
        byKind.set(row.kind, row);
      }
    }

    const result = Array.from(byKind.values()).map((row) => {
      const wt = workflowRegistry.get(row.kind);
      return {
        id: row.id,
        tenantId: row.tenantId,
        kind: row.kind,
        enabledAt: row.enabledAt,
        name: wt?.name ?? row.kind,
        description: wt?.description ?? '',
        assignments: (row.assignments ?? {}) as WorkflowAssignments,
      };
    });

    return c.json(result);
  });

  // ─── Enable a workflow kind for the current tenant ────────────────
  router.post('/workflows/enabled', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const kind = typeof body.kind === 'string' ? body.kind : undefined;
    const requestedTenantId = typeof body.tenantId === 'string' ? body.tenantId : null;

    if (!kind) {
      log.warn('Workflow kind is required for enablement');
      return c.json({ error: 'kind is required' }, 400);
    }

    if (!workflowRegistry.isValid(kind)) {
      log.warn('Unknown workflow kind for enablement', { kind });
      return c.json({ error: `Unknown workflow kind: ${kind}` }, 400);
    }

    const userId = c.get('userId');
    const { context: userContext, forbidden } = await getRequestedUserContext(
      db,
      userId,
      requestedTenantId
    );
    if (forbidden) {
      log.warn('User requested workflow enablement for inaccessible tenant', {
        userId,
        requestedTenantId,
      });
      return c.json({ error: 'Tenant not accessible' }, 403);
    }
    if (!userContext) {
      log.warn('User context not found', { userId });
      return c.json({ error: 'User context not found' }, 400);
    }

    const wt = workflowRegistry.get(kind)!;

    const validation = await validateAssignments(db, userContext.tenantId, wt, body.assignments);
    if (!validation.ok) {
      log.warn('Workflow assignment validation failed', { kind, error: validation.error });
      return c.json({ error: validation.error }, 400);
    }

    const id = `wkf_${randomUUID().replace(/-/g, '')}`;
    const [row] = await db
      .insert(enabledWorkflow)
      .values({
        id,
        tenantId: userContext.tenantId,
        principalId: userContext.principalId,
        kind,
        assignments: validation.assignments,
      })
      .onConflictDoUpdate({
        target: [enabledWorkflow.tenantId, enabledWorkflow.principalId, enabledWorkflow.kind],
        set: { kind, assignments: validation.assignments },
      })
      .returning();

    log.info('Workflow kind enabled', {
      tenantId: userContext.tenantId,
      principalId: userContext.principalId,
      kind,
    });

    return c.json({
      id: row!.id,
      tenantId: row!.tenantId,
      kind: row!.kind,
      enabledAt: row!.enabledAt,
      name: wt.name,
      description: wt.description,
      assignments: validation.assignments,
    });
  });

  // ─── Create workflow (intake) ─────────────────────────────────────
  router.post('/workflows', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const transcriptText = typeof body.transcript === 'string' ? body.transcript : undefined;
    const granolaId = typeof body.granolaId === 'string' ? body.granolaId : undefined;
    const source = typeof body.source === 'string' ? body.source : undefined;
    const workflowKind = typeof body.workflowKind === 'string' ? body.workflowKind : undefined;
    const requestedTenantId = typeof body.tenantId === 'string' ? body.tenantId : null;
    const requestedCallTitle = typeof body.callTitle === 'string' ? body.callTitle.trim() : '';

    const workflowSource = source === 'paste' || source === 'granola' ? source : undefined;

    if (!workflowKind) {
      log.warn('Workflow kind is required');
      return c.json({ error: 'workflowKind is required' }, 400);
    }
    if (!workflowRegistry.isValid(workflowKind)) {
      log.warn('Invalid workflow kind', { workflowKind });
      return c.json({ error: `Invalid workflow kind: ${workflowKind}` }, 400);
    }

    const userId = c.get('userId');
    const { context: userContext, forbidden } = await getRequestedUserContext(
      db,
      userId,
      requestedTenantId
    );
    if (forbidden) {
      log.warn('User requested workflow creation for inaccessible tenant', {
        userId,
        requestedTenantId,
      });
      return c.json({ error: 'Tenant not accessible' }, 403);
    }
    if (!userContext) {
      log.warn('User context not found', { userId });
      return c.json({ error: 'User context not found' }, 400);
    }

    const enabledRow = await db.query.enabledWorkflow.findFirst({
      where: and(
        eq(enabledWorkflow.tenantId, userContext.tenantId),
        or(
          eq(enabledWorkflow.principalId, userContext.principalId),
          isNull(enabledWorkflow.principalId)
        ),
        eq(enabledWorkflow.kind, workflowKind)
      ),
    });
    if (!enabledRow) {
      log.warn('Workflow kind not enabled for tenant', {
        workflowKind,
        tenantId: userContext.tenantId,
      });
      return c.json({ error: `Workflow kind not enabled for this tenant: ${workflowKind}` }, 400);
    }

    log.info('Creating workflow', { workflowKind, source });

    if (workflowKind === 'presentation-generation') {
      const [wfRow] = await db
        .insert(workflowRun)
        .values({
          tenantId: userContext.tenantId,
          principalId: userContext.principalId,
          kind: workflowKind,
          status: 'pending',
          input: {},
        })
        .returning();
      if (!wfRow) {
        log.error('Failed to create presentation workflow row', {
          tenantId: userContext.tenantId,
        });
        return c.json({ error: 'Failed to create workflow' }, 500);
      }
      log.info('Presentation generation workflow created', { workflowId: wfRow.id });
      return c.json({ id: wfRow.id, status: wfRow.status, kind: wfRow.kind }, 201);
    }

    if (!workflowSource) {
      log.warn('Invalid source', { source });
      return c.json({ error: 'Invalid source' }, 400);
    }

    let content: string;
    let callTitle = requestedCallTitle;

    if (workflowSource === 'paste') {
      if (!transcriptText || transcriptText.trim().length === 0) {
        log.warn('Missing transcript for paste source');
        return c.json({ error: 'transcript is required' }, 400);
      }
      if (transcriptText.length > 500000) {
        log.warn('Transcript too long', { length: transcriptText.length });
        return c.json({ error: 'transcript exceeds maximum length' }, 413);
      }
      content = transcriptText;
      if (!callTitle) callTitle = 'Pasted transcript';
      log.info('Transcript received', { length: content.length });
    } else {
      if (!granolaId) {
        log.warn('Missing granolaId for granola source');
        return c.json({ error: 'granolaId is required' }, 400);
      }
      const granolaApiKey = await resolveStepGranolaApiKey(
        db,
        userContext.tenantId,
        userContext.principalId,
        workflowKind
      );
      if (!granolaApiKey) {
        log.warn('Granola credential not configured for tenant', {
          tenantId: userContext.tenantId,
        });
        return c.json({ error: 'No Granola credential configured for this workbench' }, 400);
      }
      try {
        const note = await getNoteWithTranscript(granolaApiKey, granolaId);
        content = transcriptToText(note) || note.summary || note.title || '';
        callTitle = callTitle || note.title || 'Granola call';
        log.info('Granola note fetched', { granolaId, length: content.length });
      } catch (err) {
        log.error('Failed to fetch from Granola', {
          granolaId,
          error: err instanceof Error ? err.message : String(err),
        });
        return c.json({ error: 'Failed to fetch from Granola' }, 400);
      }
      if (content.trim().length === 0) {
        log.warn('Granola note has no usable content', { granolaId });
        return c.json({ error: 'Granola note has no usable content' }, 400);
      }
    }

    // Validate before inserting the transcript so a validation failure does not
    // leave an orphaned transcript row. transcriptId is generated on insert, so
    // validate the candidate input with a placeholder to exercise the same
    // required-field check the persisted input will satisfy.
    const candidateInput = {
      transcriptId: 'pending',
      transcriptSource: workflowSource,
      callTitle,
    };
    const inputValidation = validateWorkflowInput(workflowKind, candidateInput);
    if (!inputValidation.valid) {
      log.warn('Workflow input validation failed', {
        workflowKind,
        error: inputValidation.error,
      });
      return c.json({ error: inputValidation.error }, 400);
    }

    const [txRow] = await db
      .insert(transcript)
      .values({ content, source: workflowSource })
      .returning();
    if (!txRow) {
      log.error('Failed to create transcript row', { workflowKind });
      return c.json({ error: 'Failed to create transcript' }, 500);
    }

    const workflowInput = { transcriptId: txRow.id, transcriptSource: workflowSource, callTitle };

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
    if (!wfRow) {
      log.error('Failed to create workflow row', {
        workflowKind,
        tenantId: userContext.tenantId,
        principalId: userContext.principalId,
      });
      return c.json({ error: 'Failed to create workflow' }, 500);
    }

    const workflowDefinition = workflowRegistry.get(workflowKind);
    const intakeArtifacts = workflowDefinition?.createIntakeArtifacts?.({
      input: workflowInput,
      content,
      callTitle,
    });
    for (const draft of intakeArtifacts ?? []) {
      await db.insert(artifact).values({
        tenantId: userContext.tenantId,
        principalId: userContext.principalId,
        sessionId: wfRow.id,
        kind: draft.kind,
        title: draft.title,
        content: draft.content,
        status: draft.status ?? 'draft',
        version: draft.version ?? 1,
      });
    }

    log.info('Workflow created', {
      workflowId: wfRow.id,
      transcriptId: txRow.id,
      kind: wfRow.kind,
      status: wfRow.status,
    });

    // Auto-trigger the first step after intake. We consult the workflow
    // definition so this works for any workflow shape, not just
    // collateral-generation's hardcoded analyze step.
    const firstStep = getFirstRunnableStep(workflowKind);
    let autoTriggerStatus = wfRow.status;
    if (firstStep) {
      const stepSource = await resolveStepInferenceSource(
        db,
        userContext.tenantId,
        userContext.principalId,
        wfRow.kind,
        firstStep
      );
      if (stepSource) {
        autoTriggerStatus = 'analyzing';
        await db
          .update(workflowRun)
          .set({ status: 'analyzing' })
          .where(eq(workflowRun.id, wfRow.id));
        void triggerStep(
          db,
          wfRow.id,
          userContext,
          firstStep,
          stepSource,
          DEFAULT_STEP_MAX_OUTPUT_TOKENS[firstStep as keyof typeof DEFAULT_STEP_MAX_OUTPUT_TOKENS]
        );
      } else {
        log.warn('Step credentials not resolvable — auto-trigger skipped', {
          workflowId: wfRow.id,
          tenantId: userContext.tenantId,
          step: firstStep,
        });
      }
    }

    return c.json(
      {
        id: wfRow.id,
        status: mapDbStatusToSessionStatus(autoTriggerStatus),
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

    // Batch the per-row enrichments into two queries instead of two per
    // session (~101 queries for a full page). Build lookup maps, then assemble
    // the response synchronously.
    const transcriptIds = sessions
      .map((s) => (s.input as WorkflowInput)?.transcriptId)
      .filter((id): id is string => typeof id === 'string');
    const sessionIds = sessions.map((s) => s.id);

    const [transcripts, allPoints] = await Promise.all([
      transcriptIds.length > 0
        ? db.query.transcript.findMany({
            where: inArray(transcript.id, transcriptIds),
            columns: { id: true, content: true },
          })
        : Promise.resolve([]),
      sessionIds.length > 0
        ? db.query.painPoint.findMany({
            where: inArray(painPoint.sessionId, sessionIds),
            columns: { id: true, context: true, sessionId: true },
            // Deterministic firstPainPoint: oldest pain point per session, with
            // id as a stable tiebreaker for rows sharing a createdAt timestamp.
            orderBy: [asc(painPoint.createdAt), asc(painPoint.id)],
          })
        : Promise.resolve([]),
    ]);

    const transcriptById = new Map(transcripts.map((t) => [t.id, t]));
    const pointsBySession = new Map<string, Array<{ context: string }>>();
    for (const p of allPoints) {
      const bucket = pointsBySession.get(p.sessionId);
      if (bucket) {
        bucket.push(p);
      } else {
        pointsBySession.set(p.sessionId, [p]);
      }
    }

    const rows = sessions.map((s: (typeof sessions)[number]) => {
      const transcriptId = (s.input as WorkflowInput)?.transcriptId;
      const tx = transcriptId ? transcriptById.get(transcriptId) : undefined;
      const points = pointsBySession.get(s.id) ?? [];
      return {
        id: s.id,
        kind: s.kind,
        status: mapDbStatusToSessionStatus(s.status),
        createdAt: s.createdAt,
        transcriptId: transcriptId ?? null,
        companyName: (s.input as WorkflowInput)?.companyName ?? null,
        transcriptPreview: tx?.content?.slice(0, 80) ?? null,
        painPointCount: points.length,
        firstPainPoint: points[0]?.context ?? null,
      };
    });

    return c.json(rows);
  });

  // ─── List artifacts (aggregate across the user's sessions) ──────────
  router.get('/artifacts', async (c) => {
    const userId = c.get('userId');

    const requestedTenantId = c.req.query('tenantId');
    const searchQuery = (c.req.query('query')?.trim() ?? '')
      .slice(0, 200)
      .replace(/[%_\\]/g, '\\$&');
    const sortParam = c.req.query('sort');
    const kindParam = c.req.query('kind');
    const statusParam = c.req.query('status');
    const cursorParam = c.req.query('cursor');
    const limitParam = c.req.query('limit');

    type ArtifactStatusValue = (typeof artifactStatus)[number];
    const isArtifactStatus = (value: string): value is ArtifactStatusValue =>
      (artifactStatus as readonly string[]).includes(value);

    let statusFilter: ArtifactStatusValue | undefined;
    if (statusParam !== undefined) {
      if (!isArtifactStatus(statusParam)) {
        return c.json({ error: 'Invalid status filter' }, 400);
      }
      statusFilter = statusParam;
    }

    const pageLimit = Math.min(Math.max(1, Number(limitParam ?? 20) || 20), 100);

    const { context: userContext, forbidden } = await getRequestedUserContext(
      db,
      userId,
      requestedTenantId
    );
    if (forbidden) {
      log.warn('User requested artifacts for inaccessible tenant', { userId, requestedTenantId });
      return c.json({ error: 'Tenant not accessible' }, 403);
    }
    if (!userContext) {
      log.warn('User context not found', { userId });
      return c.json({ artifacts: [], nextCursor: null });
    }

    const sessions = await db.query.workflowRun.findMany({
      where: requestedTenantId
        ? and(
            eq(workflowRun.tenantId, userContext.tenantId),
            eq(workflowRun.principalId, userContext.principalId)
          )
        : eq(workflowRun.principalId, userContext.principalId),
      orderBy: [desc(workflowRun.createdAt)],
      limit: 50,
    });

    const sessionById = new Map<string, (typeof sessions)[number]>(
      sessions.map((s: (typeof sessions)[number]) => [s.id, s])
    );

    // Agent-written artifacts carry tenantId but a synthetic instance principalId that
    // never matches a human user's principalId. Match on tenantId only so workspace
    // members see all artifacts produced for their tenant (agents + workflows).
    const directArtifactWhere = eq(artifact.tenantId, userContext.tenantId);

    const ownershipWhere =
      sessions.length > 0
        ? or(
            inArray(
              artifact.sessionId,
              sessions.map((s: (typeof sessions)[number]) => s.id)
            ),
            directArtifactWhere
          )
        : directArtifactWhere;

    const searchWhere = searchQuery
      ? or(ilike(artifact.title, `%${searchQuery}%`), ilike(artifact.content, `%${searchQuery}%`))
      : undefined;

    const hideRejectedWhere =
      statusFilter === undefined ? ne(artifact.status, 'rejected') : undefined;
    const statusWhere = statusFilter ? eq(artifact.status, statusFilter) : undefined;
    // `kind` is intentionally not validated against a closed vocabulary: the DB
    // column is free-form text and agents write arbitrary kinds, so an unknown
    // kind is a legitimate (empty) filter rather than a 400. This asymmetry with
    // `status` (a closed enum) is deliberate.
    const kindWhere = kindParam ? eq(artifact.kind, kindParam) : undefined;

    let cursorWhere: ReturnType<typeof or> | undefined;
    if (cursorParam !== undefined) {
      const separatorIndex = cursorParam.lastIndexOf('__');
      const cursorDate = new Date(cursorParam.slice(0, separatorIndex));
      const cursorId = cursorParam.slice(separatorIndex + 2);
      if (separatorIndex === -1 || Number.isNaN(cursorDate.getTime()) || cursorId.length === 0) {
        return c.json({ error: 'Invalid cursor' }, 400);
      }
      // Keyset pagination must walk in the same direction as the sort, with the
      // id tie-break matching: ascending for oldest-first, descending otherwise.
      cursorWhere =
        sortParam === 'oldest'
          ? or(
              gt(artifact.updatedAt, cursorDate),
              and(eq(artifact.updatedAt, cursorDate), gt(artifact.id, cursorId))
            )
          : or(
              lt(artifact.updatedAt, cursorDate),
              and(eq(artifact.updatedAt, cursorDate), lt(artifact.id, cursorId))
            );
    }

    const whereConditions = [
      ownershipWhere,
      hideRejectedWhere,
      statusWhere,
      kindWhere,
      searchWhere,
      cursorWhere,
    ].filter((c): c is NonNullable<typeof c> => c != null);

    const orderBy =
      sortParam === 'oldest'
        ? [asc(artifact.updatedAt), asc(artifact.id)]
        : [desc(artifact.updatedAt), desc(artifact.id)];

    const fetched = await db.query.artifact.findMany({
      where: whereConditions.length > 0 ? and(...whereConditions) : undefined,
      orderBy,
      limit: pageLimit + 1,
    });

    let nextCursor: string | null = null;
    let page = fetched;
    if (fetched.length > pageLimit) {
      page = fetched.slice(0, pageLimit);
      const last = page[page.length - 1];
      if (last) {
        nextCursor = `${last.updatedAt.toISOString()}__${last.id}`;
      }
    }

    const rows = page.map((a) => {
      const session = a.sessionId !== null ? sessionById.get(a.sessionId) : undefined;
      return {
        ...serializeArtifact(a),
        sessionName: session
          ? deriveWorkflowDisplayName(session.kind, session.input as WorkflowInput)
          : null,
        sessionStatus: session ? mapDbStatusToSessionStatus(session.status) : null,
      };
    });

    return c.json({ artifacts: rows, nextCursor });
  });

  // ─── Read workflow ──────────────────────────────────────────────────
  router.get('/workflows/:id', async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    log.info('Fetching workflow', { workflowId: id });

    const wf = await db.query.workflowRun.findFirst({
      where: eq(workflowRun.id, id),
    });
    if (!wf) {
      log.warn('Workflow not found', { workflowId: id });
      return c.json({ error: 'Workflow not found' }, 404);
    }

    const { context: userContext, forbidden } = await getRequestedUserContext(
      db,
      userId,
      wf.tenantId
    );
    if (forbidden || !userContext) {
      log.warn('User does not have access to workflow tenant', { userId, workflowId: id });
      return c.json({ error: 'Workflow not found' }, 404);
    }
    // Workflow runs are principal-private (the list route is principal-scoped),
    // and a run exposes the raw transcript + pain points. A tenant member must
    // not read another member's run. 404 (not 403) to avoid leaking existence,
    // matching the read model of GET /workflows.
    if (!isWorkflowOwner(wf, userContext)) {
      log.warn('Caller is not the workflow owner', { userId, workflowId: id });
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

    const currentStep = deriveCurrentStepForWorkflow(wf.status, wf.kind);
    log.info('Workflow fetched', {
      workflowId: id,
      currentStep,
      painPointsCount: points.length,
      artifactCount: allArtifacts.length,
    });

    const stepConfig: WorkflowStepConfig = (wf.input as WorkflowInput)?.stepConfig ?? {};
    const rawInput = (wf.input as Record<string, unknown>) ?? {};

    // Each workflow owns how its steps serialize — the host stays
    // domain-agnostic and never hardcodes a workflow's step list.
    const workflowDef = workflowRegistry.get(wf.kind);
    const intakeTranscript = tx
      ? { id: transcriptId ?? null, content: tx.content }
      : { id: transcriptId ?? null };
    const steps =
      workflowDef?.serializeStepState?.({
        status: wf.status,
        input: rawInput,
        intakeTranscript,
        painPoints: points.map(serializePainPoint),
        artifacts: allArtifacts.map(serializeArtifact),
      }) ?? {};

    return c.json({
      id,
      kind: wf.kind,
      status: mapDbStatusToSessionStatus(wf.status),
      currentStep,
      companyName: (wf.input as WorkflowInput)?.companyName ?? null,
      stepConfig,
      steps,
    });
  });

  // ─── Run step ───────────────────────────────────────────────────────
  router.post('/workflows/:id/steps', async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    const body = (await c.req.json().catch(() => ({}))) as {
      step?: string;
      painPointIds?: string[];
      collateralTypes?: string[];
      artifactId?: string;
      feedback?: string;
      target?: string;
      templateId?: string;
      audience?: string;
      tone?: string;
      goal?: string;
      transcriptSource?: string;
      transcript?: string;
      granolaId?: string;
      callTitle?: string;
      sourceArtifactId?: string;
      agentInstanceId?: string;
    };

    log.info('Running step', { workflowId: id, step: body.step });

    const wf = await db.query.workflowRun.findFirst({
      where: eq(workflowRun.id, id),
    });
    if (!wf) {
      log.warn('Workflow not found for step', { workflowId: id });
      return c.json({ error: 'Workflow not found' }, 404);
    }

    const { context: userContext, forbidden } = await getRequestedUserContext(
      db,
      userId,
      wf.tenantId
    );
    if (forbidden || !userContext) {
      log.warn('User does not have access to workflow tenant', { userId, workflowId: id });
      return c.json({ error: 'Workflow not found' }, 404);
    }
    if (!isWorkflowOwner(wf, userContext)) {
      log.warn('Caller is not the workflow owner', { userId, workflowId: id });
      return c.json({ error: 'Forbidden' }, 403);
    }

    const step = body.step ?? deriveCurrentStepForWorkflow(wf.status, wf.kind);

    if (step === 'template' && wf.kind === 'presentation-generation') {
      if (wf.status !== 'pending' && wf.status !== 'failed') {
        return c.json({ error: 'Template step can only be submitted from pending status' }, 409);
      }
      const currentInput = (wf.input as Record<string, unknown>) ?? {};
      await db
        .update(workflowRun)
        .set({
          status: 'analyzing',
          input: {
            ...currentInput,
            templateSubmitted: true,
            templateId: body.templateId,
            audience: body.audience,
            tone: body.tone,
            goal: body.goal,
          },
        })
        .where(eq(workflowRun.id, id));
      return c.json({ status: 'analyzing' });
    }

    if (step === 'source' && wf.kind === 'presentation-generation') {
      const transcriptSource = body.transcriptSource;
      const currentInput = (wf.input as Record<string, unknown>) ?? {};

      if (transcriptSource === 'artifact') {
        if (!body.sourceArtifactId) {
          return c.json({ error: 'sourceArtifactId is required' }, 400);
        }
        // Scope the referenced artifact to the caller's tenant so a workflow
        // cannot pull source content from another tenant's artifact. Tenant
        // scope (not principal) is intentional: artifacts are shared library
        // resources within a tenant, unlike workflows which are principal-owned
        // (see isWorkflowOwner). Tightening to principal ownership is a separate
        // product decision about artifact sharing, out of scope here.
        const sourceArtifact = await db.query.artifact.findFirst({
          where: eq(artifact.id, body.sourceArtifactId),
        });
        if (!sourceArtifact || sourceArtifact.tenantId !== userContext.tenantId) {
          log.warn('sourceArtifactId not accessible to caller tenant', {
            workflowId: id,
            sourceArtifactId: body.sourceArtifactId,
          });
          return c.json({ error: 'Source artifact not found' }, 404);
        }
        const callTitle = body.callTitle?.trim() || sourceArtifact.title;
        await db
          .update(workflowRun)
          .set({
            status: 'running',
            input: {
              ...currentInput,
              transcriptSource: 'artifact',
              sourceArtifactId: body.sourceArtifactId,
              callTitle,
            },
          })
          .where(eq(workflowRun.id, id));
        return c.json({ status: 'running' });
      }

      if (transcriptSource === 'paste') {
        if (!body.transcript || body.transcript.trim().length === 0) {
          return c.json({ error: 'transcript is required' }, 400);
        }
        const callTitle = body.callTitle?.trim() || 'Pasted transcript';
        const [txRow] = await db
          .insert(transcript)
          .values({ content: body.transcript, source: 'paste' })
          .returning();
        if (!txRow) return c.json({ error: 'Failed to create transcript' }, 500);
        const newInput = {
          ...currentInput,
          transcriptSource: 'paste',
          transcriptId: txRow.id,
          callTitle,
        };
        const workflowDef = workflowRegistry.get(wf.kind);
        const intakeArtifacts = workflowDef?.createIntakeArtifacts?.({
          input: newInput,
          content: body.transcript,
          callTitle,
        });
        for (const draft of intakeArtifacts ?? []) {
          await db.insert(artifact).values({
            tenantId: userContext.tenantId,
            principalId: userContext.principalId,
            sessionId: wf.id,
            kind: draft.kind,
            title: draft.title,
            content: draft.content,
            status: draft.status ?? 'draft',
            version: draft.version ?? 1,
          });
        }
        await db
          .update(workflowRun)
          .set({ status: 'running', input: newInput })
          .where(eq(workflowRun.id, id));
        return c.json({ status: 'running' });
      }

      if (transcriptSource === 'granola') {
        if (!body.granolaId) {
          return c.json({ error: 'granolaId is required' }, 400);
        }
        const granolaApiKey = await resolveStepGranolaApiKey(
          db,
          userContext.tenantId,
          userContext.principalId,
          wf.kind,
          'source'
        );
        if (!granolaApiKey) {
          return c.json({ error: 'No Granola credential configured for this workbench' }, 400);
        }
        let granolaContent: string;
        let granolaCallTitle: string;
        try {
          const note = await getNoteWithTranscript(granolaApiKey, body.granolaId);
          granolaContent = transcriptToText(note) || note.summary || note.title || '';
          granolaCallTitle = body.callTitle?.trim() || (note.title as string) || 'Granola call';
        } catch (err) {
          log.error('Failed to fetch from Granola', {
            granolaId: body.granolaId,
            error: err instanceof Error ? err.message : String(err),
          });
          return c.json({ error: 'Failed to fetch from Granola' }, 400);
        }
        if (granolaContent.trim().length === 0) {
          return c.json({ error: 'Granola note has no usable content' }, 400);
        }
        const [txRow] = await db
          .insert(transcript)
          .values({ content: granolaContent, source: 'granola' })
          .returning();
        if (!txRow) return c.json({ error: 'Failed to create transcript' }, 500);
        const newInput = {
          ...currentInput,
          transcriptSource: 'granola',
          transcriptId: txRow.id,
          callTitle: granolaCallTitle,
        };
        const workflowDef = workflowRegistry.get(wf.kind);
        const intakeArtifacts = workflowDef?.createIntakeArtifacts?.({
          input: newInput,
          content: granolaContent,
          callTitle: granolaCallTitle,
        });
        for (const draft of intakeArtifacts ?? []) {
          await db.insert(artifact).values({
            tenantId: userContext.tenantId,
            principalId: userContext.principalId,
            sessionId: wf.id,
            kind: draft.kind,
            title: draft.title,
            content: draft.content,
            status: draft.status ?? 'draft',
            version: draft.version ?? 1,
          });
        }
        await db
          .update(workflowRun)
          .set({ status: 'running', input: newInput })
          .where(eq(workflowRun.id, id));
        return c.json({ status: 'running' });
      }

      return c.json({ error: 'transcriptSource must be paste, granola, or artifact' }, 400);
    }

    if (step === 'generate' && wf.kind === 'presentation-generation') {
      if (!body.agentInstanceId) {
        log.warn('Generate called without agentInstanceId', { workflowId: id });
        return c.json({ error: 'agentInstanceId is required to dispatch to Geralt' }, 400);
      }
      if (!sessionService) {
        log.error('sessionService not configured in workflow router');
        return c.json({ error: 'Session service not configured' }, 500);
      }
      const instance = await db.query.agentInstance.findFirst({
        where: eq(intxSchema.agentInstance.id, body.agentInstanceId),
      });
      if (!instance || instance.tenantId !== userContext.tenantId) {
        log.warn('Geralt agent instance not found', {
          agentInstanceId: body.agentInstanceId,
          tenantId: userContext.tenantId,
        });
        return c.json({ error: 'Agent instance not found' }, 404);
      }
      if (!instance.sessionId) {
        log.warn('Geralt agent instance is not running', {
          agentInstanceId: body.agentInstanceId,
        });
        return c.json({ error: 'Geralt agent is not running. Launch it first.' }, 400);
      }
      if (!instance.address) {
        log.warn('Geralt agent instance has no address', {
          agentInstanceId: body.agentInstanceId,
        });
        return c.json({ error: 'Geralt agent is not reachable yet. Try again in a moment.' }, 503);
      }
      const wfInput = (wf.input as Record<string, unknown>) ?? {};
      const briefLines: string[] = [];
      if (typeof wfInput.templateId === 'string')
        briefLines.push(`Template: ${wfInput.templateId}`);
      if (typeof wfInput.audience === 'string') briefLines.push(`Audience: ${wfInput.audience}`);
      if (typeof wfInput.tone === 'string') briefLines.push(`Tone: ${wfInput.tone}`);
      if (typeof wfInput.goal === 'string') briefLines.push(`Goal: ${wfInput.goal}`);
      if (typeof wfInput.callTitle === 'string') briefLines.push(`Call: ${wfInput.callTitle}`);
      let transcriptContent = '';
      if (typeof wfInput.transcriptId === 'string') {
        const txRow = await db.query.transcript.findFirst({
          where: eq(transcript.id, wfInput.transcriptId),
        });
        transcriptContent = txRow?.content ?? '';
      } else if (typeof wfInput.sourceArtifactId === 'string') {
        // Artifact-sourced presentations carry their content on the artifact,
        // not a transcript row — read it so the brief is not empty.
        const sourceArtifact = await db.query.artifact.findFirst({
          where: eq(artifact.id, wfInput.sourceArtifactId),
        });
        transcriptContent = sourceArtifact?.content ?? '';
      }
      const brief =
        briefLines.join('\n') + (transcriptContent ? `\n\nSource:\n${transcriptContent}` : '');
      const kp = await generateKeyPair();
      const cryptoProvider = createNodeCrypto(kp);
      const mailId = generateId('sessionMail');
      try {
        await sessionService.sendUserMessage({
          agentAddress: instance.address,
          from: 'workflow@system',
          messageId: `<${mailId}@system>`,
          date: new Date(),
          content: brief,
          sessionId: instance.sessionId,
          tenantId: userContext.tenantId,
          cryptoProvider,
        });
      } catch (err) {
        log.error('Failed to dispatch presentation brief to Geralt', {
          workflowId: id,
          agentInstanceId: body.agentInstanceId,
          error: err instanceof Error ? err.message : String(err),
        });
        return c.json(
          { error: 'Failed to reach the Geralt agent. Make sure it is running, then try again.' },
          503
        );
      }
      // Persist which Geralt received the brief so the selected-workflow panel
      // links the user to the session that is actually building the deck.
      await db
        .update(workflowRun)
        .set({
          status: 'generating',
          input: { ...wfInput, agentInstanceId: body.agentInstanceId },
        })
        .where(eq(workflowRun.id, id));
      log.info('Presentation generation dispatched to Geralt', {
        workflowId: id,
        agentInstanceId: body.agentInstanceId,
      });
      return c.json({ status: 'generating' });
    }

    if (step === 'analyze' || step === 'generate') {
      // A step runs in one of two modes. Agent mode: the step is assigned a
      // tenant agent, which carries its own inference provider — resolve the
      // source from the agent definition, no per-step credential needed. Inline
      // mode (no assigned agent): resolve the step's configured workflow LLM
      // credential.
      const configurableStep = step as ConfigurableStep;
      const assignedAgentId = (wf.input as WorkflowInput)?.stepConfig?.[configurableStep]?.agentId;
      const source = assignedAgentId
        ? await resolveAgentStepInferenceSource(db, userContext.tenantId, assignedAgentId)
        : await resolveStepInferenceSource(
            db,
            userContext.tenantId,
            userContext.principalId,
            wf.kind,
            step
          );
      if (!source) {
        if (assignedAgentId) {
          log.warn('Assigned agent has no resolvable inference source', {
            tenantId: userContext.tenantId,
            agentId: assignedAgentId,
          });
          return c.json(
            {
              error:
                'The agent assigned to this step has no resolvable inference provider. Check the agent and its credentials.',
            },
            400
          );
        }
        log.warn('No workflow LLM credential configured', { tenantId: userContext.tenantId });
        return c.json(
          {
            error: 'No LLM credential configured for this step. Add one in the workflow settings.',
          },
          400
        );
      }

      // Output-token cap for this step: explicit per-step override, else the
      // per-step default. Tuned to the model, since reasoning models otherwise
      // burn the budget on think blocks and truncate the response.
      const maxOutputTokens =
        (wf.input as WorkflowInput)?.stepConfig?.[configurableStep]?.maxOutputTokens ??
        DEFAULT_STEP_MAX_OUTPUT_TOKENS[configurableStep];

      if (step === 'analyze') {
        return runAnalyze(db, id, userContext, source, body.feedback, maxOutputTokens);
      }
      // step === 'generate'
      if (!Array.isArray(body.painPointIds) || body.painPointIds.length === 0) {
        log.warn('Generate called without pain point selection', { workflowId: id });
        return c.json({ error: 'Select at least one pain point to generate collateral.' }, 400);
      }
      if (!Array.isArray(body.collateralTypes) || body.collateralTypes.length === 0) {
        log.warn('Generate called without collateral type selection', { workflowId: id });
        return c.json({ error: 'Select at least one collateral type to generate.' }, 400);
      }
      return runGenerate(
        db,
        id,
        body.painPointIds,
        body.collateralTypes,
        userContext.principalId,
        source,
        maxOutputTokens
      );
    }

    log.warn('Invalid step', { workflowId: id, step });
    return c.json({ error: 'Invalid step' }, 400);
  });

  // ─── Reset a stuck workflow ─────────────────────────────────────────
  // Recovery path for a run wedged in an in-progress status by a hung inference
  // call (CL-1922). Moves it back to a state the user can act on.
  router.post('/workflows/:id/reset', async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');

    const wf = await db.query.workflowRun.findFirst({
      where: eq(workflowRun.id, id),
    });
    if (!wf) return c.json({ error: 'Workflow not found' }, 404);

    const { context: userContext, forbidden } = await getRequestedUserContext(
      db,
      userId,
      wf.tenantId
    );
    if (forbidden || !userContext) return c.json({ error: 'Workflow not found' }, 404);
    if (!isWorkflowOwner(wf, userContext)) {
      log.warn('Caller is not the workflow owner', { userId, workflowId: id });
      return c.json({ error: 'Forbidden' }, 403);
    }

    const resetStatus = resolveResetStatus(wf.status);
    if (!resetStatus) {
      return c.json({ error: 'Workflow is not in a resettable (stuck) status' }, 409);
    }

    await db.update(workflowRun).set({ status: resetStatus }).where(eq(workflowRun.id, id));
    log.info('Workflow reset from stuck status', {
      workflowId: id,
      from: wf.status,
      to: resetStatus,
    });
    return c.json({ id, status: mapDbStatusToSessionStatus(resetStatus) });
  });

  // ─── Artifact approval ──────────────────────────────────────────────
  router.patch('/workflows/:id/artifacts/:artifactId/status', async (c) => {
    const id = c.req.param('id');
    const artifactId = c.req.param('artifactId');
    const userId = c.get('userId');
    const body = (await c.req.json().catch(() => ({}))) as { status?: string };
    const status = body.status === 'approved' || body.status === 'rejected' ? body.status : null;
    if (!status) return c.json({ error: 'status must be approved or rejected' }, 400);

    const wf = await db.query.workflowRun.findFirst({ where: eq(workflowRun.id, id) });
    if (!wf) return c.json({ error: 'Workflow not found' }, 404);

    const { context: userContext, forbidden } = await getRequestedUserContext(
      db,
      userId,
      wf.tenantId
    );
    if (forbidden || !userContext) return c.json({ error: 'Workflow not found' }, 404);
    if (!isWorkflowOwner(wf, userContext)) {
      log.warn('Caller is not the workflow owner', { userId, workflowId: id });
      return c.json({ error: 'Forbidden' }, 403);
    }

    const [row] = await db
      .update(artifact)
      .set({ status })
      .where(and(eq(artifact.id, artifactId), eq(artifact.sessionId, id)))
      .returning();

    if (!row) return c.json({ error: 'Artifact not found' }, 404);

    // Approval is the final human-in-the-loop step. The workflow is only done
    // once every collateral artifact has been reviewed (no drafts remain).
    // `wf.status` is read at the top of the handler, so two simultaneous PATCHes
    // could both run this check; the transition is idempotent by design (setting
    // 'done' twice is harmless), so it is not serialized. The terminal request
    // always observes its own committed write and flips the run.
    if (wf.status === 'reviewing') {
      const remaining = await db.query.artifact.findMany({
        where: eq(artifact.sessionId, id),
      });
      const allReviewed = remaining
        .filter((a) => isCollateralKind(a.kind))
        .every((a) => a.status !== 'draft');
      if (allReviewed) {
        await db.update(workflowRun).set({ status: 'done' }).where(eq(workflowRun.id, id));
        log.info('All artifacts reviewed; workflow done', { workflowId: id });
      }
    }

    return c.json(serializeArtifact(row));
  });

  // ─── Update company name ────────────────────────────────────────────
  router.patch('/workflows/:id/company', async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    const body = (await c.req.json().catch(() => ({}))) as { companyName?: string };

    const companyName =
      typeof body.companyName === 'string' ? body.companyName.trim().slice(0, 200) : null;

    const wf = await db.query.workflowRun.findFirst({
      where: eq(workflowRun.id, id),
    });
    if (!wf) return c.json({ error: 'Workflow not found' }, 404);

    const { context: userContext, forbidden } = await getRequestedUserContext(
      db,
      userId,
      wf.tenantId
    );
    if (forbidden || !userContext) return c.json({ error: 'Workflow not found' }, 404);
    if (!isWorkflowOwner(wf, userContext)) {
      log.warn('Caller is not the workflow owner', { userId, workflowId: id });
      return c.json({ error: 'Forbidden' }, 403);
    }

    const updatedInput: WorkflowInput = { ...(wf.input as WorkflowInput) };
    if (companyName !== null) updatedInput.companyName = companyName;
    await db
      .update(workflowRun)
      .set({ input: updatedInput as Record<string, unknown> })
      .where(eq(workflowRun.id, id));

    log.info('Company name updated', { workflowId: id, companyName });
    return c.json({ id, companyName });
  });

  // ─── Delete workflow ────────────────────────────────────────────────
  router.delete('/workflows/:id', async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');

    const wf = await db.query.workflowRun.findFirst({
      where: eq(workflowRun.id, id),
    });
    if (!wf) return c.json({ error: 'Workflow not found' }, 404);

    const { context: userContext, forbidden } = await getRequestedUserContext(
      db,
      userId,
      wf.tenantId
    );
    if (forbidden || !userContext) return c.json({ error: 'Workflow not found' }, 404);
    if (!isWorkflowOwner(wf, userContext)) {
      log.warn('Caller is not the workflow owner', { userId, workflowId: id });
      return c.json({ error: 'Forbidden' }, 403);
    }

    // pain_point and artifact rows reference workflow_run with onDelete cascade,
    // so removing the run removes its derived rows.
    await db.delete(workflowRun).where(eq(workflowRun.id, id));

    log.info('Workflow deleted', { workflowId: id, tenantId: wf.tenantId });
    return c.json({ id, deleted: true });
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
      const maxOutputTokens = s['maxOutputTokens'] !== undefined ? s['maxOutputTokens'] : undefined;
      if (agentId !== undefined && typeof agentId !== 'string') {
        return c.json({ error: `stepConfig.${step}.agentId must be a string` }, 400);
      }
      if (
        toolIds !== undefined &&
        (!Array.isArray(toolIds) || !toolIds.every((t) => typeof t === 'string'))
      ) {
        return c.json({ error: `stepConfig.${step}.toolIds must be an array of strings` }, 400);
      }
      if (
        maxOutputTokens !== undefined &&
        (typeof maxOutputTokens !== 'number' ||
          !Number.isInteger(maxOutputTokens) ||
          maxOutputTokens < 1 ||
          maxOutputTokens > MAX_STEP_OUTPUT_TOKENS)
      ) {
        return c.json(
          {
            error: `stepConfig.${step}.maxOutputTokens must be an integer between 1 and ${MAX_STEP_OUTPUT_TOKENS}`,
          },
          400
        );
      }
      const entry: StepConfig = {};
      if (typeof agentId === 'string') entry.agentId = agentId;
      if (Array.isArray(toolIds)) entry.toolIds = toolIds as string[];
      if (typeof maxOutputTokens === 'number') entry.maxOutputTokens = maxOutputTokens;
      validatedConfig[step] = entry;
    }

    const wf = await db.query.workflowRun.findFirst({
      where: eq(workflowRun.id, id),
    });
    if (!wf) {
      log.warn('Workflow not found for step-config update', { workflowId: id });
      return c.json({ error: 'Workflow not found' }, 404);
    }

    const { context: userContext, forbidden } = await getRequestedUserContext(
      db,
      userId,
      wf.tenantId
    );
    if (forbidden || !userContext) {
      log.warn('User context not found', { userId });
      return c.json({ error: 'User context not found' }, 400);
    }
    if (!isWorkflowOwner(wf, userContext)) {
      log.warn('Caller is not the workflow owner', { userId, workflowId: id });
      return c.json({ error: 'Forbidden' }, 403);
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
      const foundIds = new Set(instances.map((i: { id: string }) => i.id));
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
    const userId = c.get('userId');
    const requestedTenantId = c.req.query('tenantId');
    const { context: userContext, forbidden } = await getRequestedUserContext(
      db,
      userId,
      requestedTenantId
    );
    if (forbidden) {
      log.warn('User requested recent calls for inaccessible tenant', {
        userId,
        requestedTenantId,
      });
      return c.json({ error: 'Tenant not accessible' }, 403);
    }
    if (!userContext) {
      log.warn('User context not found', { userId });
      return c.json({ error: 'User context not found' }, 400);
    }

    const kind = c.req.query('kind');
    const limitParam = c.req.query('limit');
    const parsedLimit = limitParam ? parseInt(limitParam, 10) : 10;
    // Clamp to a sane window so a caller cannot request an unbounded page.
    const limit = Number.isNaN(parsedLimit) ? 10 : Math.min(Math.max(1, parsedLimit), 50);
    const granolaApiKey = kind
      ? await resolveStepGranolaApiKey(db, userContext.tenantId, userContext.principalId, kind)
      : await resolveGranolaApiKey(db, userContext.tenantId);
    if (!granolaApiKey) {
      return c.json({ error: 'No Granola credential configured for this workbench' }, 400);
    }
    try {
      const calls = await getRecentNotes(granolaApiKey, limit);
      return c.json({ calls });
    } catch (err) {
      log.error('Granola fetch failed', { error: String(err) });
      return c.json({ error: 'Failed to fetch recent calls from Granola' }, 502);
    }
  });

  return router;
}
