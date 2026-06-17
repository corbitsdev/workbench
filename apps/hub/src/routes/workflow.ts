import { Hono } from 'hono';
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, max, ne, or } from 'drizzle-orm';
import { getLogger } from '@intx/log';
import { reportLoggedError } from '@workbench/sentry';
import { schema as intxSchema, getAncestorChain, ProviderMetadata } from '@intx/db';
import { type } from 'arktype';
import { listLatestGammaTemplates } from '../lib/gamma-templates';
import { workflowRegistry, flattenStepCredentialRequirements } from '@workbench/workflow-core';
import { isCredentialToolEntry, KNOWN_TOOLS } from '../lib/tool-registry';
import {
  collateralGenerationWorkflow,
  presentationGenerationWorkflow,
  isCollateralKind,
  sourceArtifactKindSkipsAnalysis,
  CSV_EXPORT_ARTIFACT_KIND,
  SELECTION_ARTIFACT_KIND,
  setSelectionChosen,
  seoEnrichmentWorkflow,
  redditOpportunityScannerWorkflow,
  blindAbComparisonWorkflow,
  validateAbComparisonProviders,
} from '@workbench/gtm-workflows';
import type { HubDb } from '../db';
import {
  workflowRun,
  transcript,
  painPoint,
  artifact,
  artifactStatus,
  artifactVersion,
  enabledWorkflow,
} from '../db/schema';
import { getNoteWithTranscript, getRecentNotes, transcriptToText } from '../lib/granola';
import { randomUUID } from 'node:crypto';
import { serializePainPoint, serializeArtifact } from '../serializers/workflow';
import { runAnalyze, runGenerate, runPresentationGenerate } from '../services/workflow-generation';
import { generateCollateralWithLLM } from '../lib/generation';
import {
  createResourceEnrichmentRun,
  isResourceEnrichmentKind,
  ResourceEnrichmentError,
  runResourceEnrichmentEnrich,
  runResourceEnrichmentExport,
} from '../services/resource-enrichment';
import { runAbComparisonExecution, persistAbComparisonResults } from '../services/ab-comparison';
import {
  RedditOpportunityScannerError,
  runRedditOpportunityAnalyze,
  runRedditOpportunityScan,
  updateRedditScanArtifactContent,
} from '../services/reddit-opportunity-scanner';
import {
  mergeRedditScanReview,
  updateOpportunityStatus,
  REDDIT_OPPORTUNITY_SCAN_ARTIFACT_KIND,
} from '@workbench/gtm-workflows/reddit-opportunity-scanner';
import {
  mapDbStatusToSessionStatus,
  deriveCurrentStepForWorkflow,
  deriveWorkflowDisplayName,
  validateWorkflowInput,
  isWorkflowOwner,
  resolveStepInferenceSource,
  resolveCredentialInferenceSource,
  providerMetadataModel,
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
workflowRegistry.register(seoEnrichmentWorkflow);
workflowRegistry.register(redditOpportunityScannerWorkflow);
workflowRegistry.register(blindAbComparisonWorkflow);

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

// Artifact kinds whose raw content may be streamed as a file download. The list
// is intentionally narrow: most artifact content is served as JSON via
// GET /artifacts, and only terminal export kinds are safe to hand a browser as
// an attachment.
const DOWNLOADABLE_ARTIFACT_KINDS: ReadonlySet<string> = new Set([CSV_EXPORT_ARTIFACT_KIND]);

// Build a safe Content-Disposition filename from an artifact title: strip quotes,
// backslashes and control characters that would break the header, drop a trailing
// .csv the title may already carry, and fall back to a stable default when empty.
export function csvDownloadFilename(title: string): string {
  const cleaned = title
    .replace(/[\r\n"\\]/g, '')
    .replace(/\.csv$/i, '')
    .trim();
  return `${cleaned.length > 0 ? cleaned : 'export'}.csv`;
}

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

export function createWorkflowRouter(db: HubDb): Hono<{ Variables: { userId: string } }> {
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

  // ─── Inference credentials available for workflow configuration ──────
  router.get('/workflows/credentials', async (c) => {
    const userId = c.get('userId');
    const userContext = await getUserContext(db, userId);
    if (!userContext) return c.json([]);

    const tenantIds = await getAncestorChain(db as never, userContext.tenantId);

    const credentials = await db.query.credential.findMany({
      where: inArray(intxSchema.credential.tenantId, tenantIds),
      orderBy: [asc(intxSchema.credential.name)],
    });

    const providerIds = [...new Set(credentials.map((c) => c.providerId))];
    const providers =
      providerIds.length > 0
        ? await db.query.provider.findMany({
            where: inArray(intxSchema.provider.id, providerIds),
          })
        : [];
    const providerById = new Map(providers.map((p) => [p.id, p]));

    const result: Array<{
      id: string;
      name: string;
      providerName: string;
      providerPlugin: string;
      baseURL: string;
      model?: string;
    }> = [];

    const INFERENCE_PLUGINS = new Set(['openai-compatible', 'anthropic', 'google-genai', 'openai']);

    for (const cred of credentials) {
      const provider = providerById.get(cred.providerId);
      if (!provider) continue;
      if (!INFERENCE_PLUGINS.has(provider.plugin)) continue;
      const parsed = ProviderMetadata(provider.metadata ?? {});
      if (parsed instanceof type.errors) continue;
      const model = providerMetadataModel(provider.metadata);
      result.push({
        id: cred.id,
        name: cred.name,
        providerName: provider.name,
        providerPlugin: provider.plugin,
        baseURL: parsed.baseURL,
        ...(model ? { model } : {}),
      });
    }

    return c.json(result);
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
  // Returns tenant-owned gamma templates from DB. Gamma has no list-templates API.
  router.get('/workflows/gamma/templates', async (c) => {
    const userId = c.get('userId');
    const userContext = await getUserContext(db, userId);
    if (!userContext) {
      return c.json([]);
    }
    const templates = await listLatestGammaTemplates(db, userContext.tenantId);
    return c.json(templates);
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
      log.warn('Workflow assignment validation failed', {
        kind,
        error: validation.error,
      });
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
    const sourceArtifactId =
      typeof body.sourceArtifactId === 'string' ? body.sourceArtifactId : undefined;
    const source = typeof body.source === 'string' ? body.source : undefined;
    const workflowKind = typeof body.workflowKind === 'string' ? body.workflowKind : undefined;
    const requestedTenantId = typeof body.tenantId === 'string' ? body.tenantId : null;
    const requestedCallTitle = typeof body.callTitle === 'string' ? body.callTitle.trim() : '';

    const workflowSource =
      source === 'paste' || source === 'granola' || source === 'artifact' ? source : undefined;

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

    if (isResourceEnrichmentKind(workflowKind)) {
      const uploadId = typeof body.uploadId === 'string' ? body.uploadId : undefined;
      if (!uploadId) {
        return c.json({ error: 'uploadId is required' }, 400);
      }
      try {
        const run = await createResourceEnrichmentRun(db, userContext, workflowKind, uploadId);
        return c.json(run, 201);
      } catch (err) {
        if (err instanceof ResourceEnrichmentError) {
          return c.json({ error: err.message }, err.status);
        }
        throw err;
      }
    }

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
      log.info('Presentation generation workflow created', {
        workflowId: wfRow.id,
      });
      return c.json({ id: wfRow.id, status: wfRow.status, kind: wfRow.kind }, 201);
    }

    if (workflowKind === 'blind-ab-comparison') {
      const providers =
        typeof body.providers === 'object' && Array.isArray(body.providers)
          ? body.providers
          : undefined;
      const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt : undefined;
      const inputDef =
        typeof body.input === 'object' && body.input !== null ? body.input : undefined;

      if (!providers || !Array.isArray(providers)) {
        return c.json({ error: 'At least two providers are required' }, 400);
      }
      const providerValidation = validateAbComparisonProviders(
        providers as Array<{ providerPlugin?: string; model?: string }>
      );
      if (!providerValidation.valid) {
        return c.json({ error: providerValidation.error }, 400);
      }
      if (!inputDef) {
        return c.json({ error: 'Input definition is required' }, 400);
      }

      const [wfRow] = await db
        .insert(workflowRun)
        .values({
          tenantId: userContext.tenantId,
          principalId: userContext.principalId,
          kind: workflowKind,
          status: 'pending',
          input: {
            providers,
            systemPrompt,
            input: inputDef,
          },
        })
        .returning();
      if (!wfRow) {
        log.error('Failed to create A/B comparison workflow row', {
          tenantId: userContext.tenantId,
        });
        return c.json({ error: 'Failed to create workflow' }, 500);
      }
      log.info('A/B comparison workflow created', { workflowId: wfRow.id });
      return c.json({ id: wfRow.id, status: wfRow.status, kind: wfRow.kind }, 201);
    }

    if (workflowKind === 'reddit-opportunity-scanner') {
      const inputUrl = typeof body.inputUrl === 'string' ? body.inputUrl.trim() : undefined;
      if (!inputUrl) {
        log.warn('Missing inputUrl for reddit-opportunity-scanner');
        return c.json({ error: 'inputUrl is required' }, 400);
      }
      if (!inputUrl.startsWith('http://') && !inputUrl.startsWith('https://')) {
        log.warn('Invalid inputUrl for reddit-opportunity-scanner', { inputUrl });
        return c.json(
          { error: 'inputUrl must be a valid URL starting with http:// or https://' },
          400
        );
      }
      const brandName = typeof body.brandName === 'string' ? body.brandName.trim() : undefined;
      const targetGeography =
        typeof body.targetGeography === 'string' ? body.targetGeography.trim() : undefined;
      const icpHints = typeof body.icpHints === 'string' ? body.icpHints.trim() : undefined;

      const [wfRow] = await db
        .insert(workflowRun)
        .values({
          tenantId: userContext.tenantId,
          principalId: userContext.principalId,
          kind: workflowKind,
          status: 'pending',
          input: {
            inputUrl,
            brandName,
            targetGeography,
            icpHints,
          },
        })
        .returning();
      if (!wfRow) {
        log.error('Failed to create reddit opportunity scanner workflow row', {
          tenantId: userContext.tenantId,
        });
        return c.json({ error: 'Failed to create workflow' }, 500);
      }
      log.info('Reddit opportunity scanner workflow created', { workflowId: wfRow.id });
      return c.json({ id: wfRow.id, status: wfRow.status, kind: wfRow.kind }, 201);
    }

    if (!workflowSource) {
      log.warn('Invalid source', { source });
      return c.json({ error: 'Invalid source' }, 400);
    }

    let content: string;
    let callTitle = requestedCallTitle;
    // Set when the run is seeded from an artifact whose kind already represents
    // a completed analysis phase (a 'pain-points' artifact). Carries the origin
    // session so its chosen pain points can be copied onto the new run, letting
    // it skip analysis and go straight to generation.
    let skipAnalysisOriginSessionId: string | null = null;

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
    } else if (workflowSource === 'artifact') {
      if (!sourceArtifactId) {
        log.warn('Missing sourceArtifactId for artifact source');
        return c.json({ error: 'sourceArtifactId is required' }, 400);
      }
      const sourceArtifact = await db.query.artifact.findFirst({
        where: and(eq(artifact.id, sourceArtifactId), eq(artifact.tenantId, userContext.tenantId)),
      });
      if (!sourceArtifact) {
        log.warn('Source artifact not found', { sourceArtifactId });
        return c.json({ error: 'Source artifact not found' }, 404);
      }
      content = sourceArtifact.content;
      if (content.trim().length === 0) {
        log.warn('Source artifact has no content', { sourceArtifactId });
        return c.json({ error: 'Source artifact has no usable content' }, 400);
      }
      if (!callTitle) callTitle = sourceArtifact.title;
      if (
        sourceArtifactKindSkipsAnalysis(workflowKind, sourceArtifact.kind) &&
        sourceArtifact.sessionId
      ) {
        skipAnalysisOriginSessionId = sourceArtifact.sessionId;
      }
      log.info('Artifact loaded as source', {
        sourceArtifactId,
        length: content.length,
      });
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

    const workflowInput = {
      transcriptId: txRow.id,
      transcriptSource: workflowSource,
      callTitle,
    };

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
        ownerPrincipalId: userContext.principalId,
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

    // Seeding from an already-analyzed pain-points artifact: copy the origin
    // run's pain points onto this run and jump straight to generation. Analysis
    // is intentionally not triggered, so the pre-selected pain points are
    // preserved rather than re-extracted.
    if (skipAnalysisOriginSessionId) {
      // Tenant isolation: the origin run must belong to the caller's tenant and
      // be owned by the caller. A pain-points artifact only carries a session id;
      // verify the backing run before copying its pain points, so a crafted
      // request cannot pull another tenant's (or member's) pain points.
      const originRun = await db.query.workflowRun.findFirst({
        where: eq(workflowRun.id, skipAnalysisOriginSessionId),
      });
      if (!originRun) {
        log.warn('Skip-analysis origin run not found', {
          workflowId: wfRow.id,
          originSessionId: skipAnalysisOriginSessionId,
        });
        return c.json({ error: 'Source artifact origin not found' }, 404);
      }
      if (originRun.tenantId !== userContext.tenantId || !isWorkflowOwner(originRun, userContext)) {
        log.warn('Skip-analysis origin run not owned by caller', {
          workflowId: wfRow.id,
          originSessionId: skipAnalysisOriginSessionId,
        });
        return c.json({ error: 'Forbidden' }, 403);
      }

      const originPainPoints = await db.query.painPoint.findMany({
        where: eq(painPoint.sessionId, skipAnalysisOriginSessionId),
      });

      // Only skip analysis when there are pain points to copy. With zero, jumping
      // to generate would dead-end (generate requires painPointIds), so fall
      // through to the normal analyze auto-trigger using the artifact content
      // already loaded as the transcript.
      if (originPainPoints.length > 0) {
        const copiedPainPoints = await db
          .insert(painPoint)
          .values(
            originPainPoints.map((point) => ({
              sessionId: wfRow.id,
              severity: point.severity,
              context: point.context,
              quote: point.quote,
              // A pain-points artifact is a curated set, so pre-select every
              // copied point — the user can generate immediately.
              selected: true,
            }))
          )
          .returning();
        await db.update(workflowRun).set({ status: 'running' }).where(eq(workflowRun.id, wfRow.id));
        log.info('Seeded collateral run from pain-points artifact, skipping analysis', {
          workflowId: wfRow.id,
          originSessionId: skipAnalysisOriginSessionId,
          painPointCount: copiedPainPoints.length,
        });
        return c.json(
          {
            id: wfRow.id,
            status: mapDbStatusToSessionStatus('running'),
            steps: {
              intake: { completed: true, transcriptId: txRow.id },
              analyze: {
                completed: true,
                painPoints: copiedPainPoints.map(serializePainPoint),
              },
            },
          },
          201
        );
      }
      log.info('Pain-points artifact origin has no pain points; falling through to analysis', {
        workflowId: wfRow.id,
        originSessionId: skipAnalysisOriginSessionId,
      });
    }

    return c.json(
      {
        id: wfRow.id,
        status: mapDbStatusToSessionStatus(wfRow.status),
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
        log.warn('User requested workflows for inaccessible tenant', {
          userId,
          requestedTenantId,
        });
        return c.json({ error: 'Tenant not accessible' }, 403);
      }

      workflowPrincipalId = requestedPrincipal.id;
    }

    const sessions = await db.query.workflowRun.findMany({
      where: requestedTenantId
        ? and(
            eq(workflowRun.tenantId, requestedTenantId),
            eq(workflowRun.principalId, workflowPrincipalId),
            isNull(workflowRun.deletedAt)
          )
        : and(eq(workflowRun.principalId, workflowPrincipalId), isNull(workflowRun.deletedAt)),
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

  // ─── Download a single artifact as a file ───────────────────────────
  // GET /artifacts/:id returns JSON; this sub-action streams the raw content
  // with an attachment disposition. Only terminal export kinds are downloadable.
  router.get('/artifacts/:id/download', async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');

    const art = await db.query.artifact.findFirst({
      where: eq(artifact.id, id),
    });
    if (!art) return c.json({ error: 'Artifact not found' }, 404);

    const { context: userContext, forbidden } = await getRequestedUserContext(
      db,
      userId,
      art.tenantId
    );
    if (forbidden) return c.json({ error: 'Forbidden' }, 403);
    if (!userContext || art.tenantId !== userContext.tenantId) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    if (!DOWNLOADABLE_ARTIFACT_KINDS.has(art.kind)) {
      return c.json({ error: `Artifact kind "${art.kind}" is not downloadable` }, 400);
    }

    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="${csvDownloadFilename(art.title)}"`);
    return c.body(art.content);
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
    const ownerPrincipalIdParam = c.req.query('ownerPrincipalId');
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
      log.warn('User requested artifacts for inaccessible tenant', {
        userId,
        requestedTenantId,
      });
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
            eq(workflowRun.principalId, userContext.principalId),
            isNull(workflowRun.deletedAt)
          )
        : and(eq(workflowRun.principalId, userContext.principalId), isNull(workflowRun.deletedAt)),
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
    const ownerWhere = ownerPrincipalIdParam
      ? eq(artifact.ownerPrincipalId, ownerPrincipalIdParam)
      : undefined;

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
      ownerWhere,
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
        ownerName: null,
      };
    });

    // Resolve owner names for the fetched page to populate the frontend filter.
    const ownerIds = [
      ...new Set(rows.map((r) => r.ownerPrincipalId).filter((id): id is string => id !== null)),
    ];
    if (ownerIds.length > 0) {
      const ownerPrincipals = await db
        .select({ id: intxSchema.principal.id, refId: intxSchema.principal.refId })
        .from(intxSchema.principal)
        .where(inArray(intxSchema.principal.id, ownerIds));
      const principalRefIds = [...new Set(ownerPrincipals.map((p) => p.refId))];
      const users =
        principalRefIds.length > 0
          ? await db
              .select({ id: intxSchema.user.id, name: intxSchema.user.name })
              .from(intxSchema.user)
              .where(inArray(intxSchema.user.id, principalRefIds))
          : [];
      const ownerNameByRefId = new Map(users.map((u) => [u.id, u.name]));
      for (const p of ownerPrincipals) {
        const name = ownerNameByRefId.get(p.refId) ?? null;
        for (const r of rows) {
          if (r.ownerPrincipalId === p.id) {
            (r as { ownerName: string | null }).ownerName = name;
          }
        }
      }
    }

    return c.json({ artifacts: rows, nextCursor });
  });

  // ─── Read workflow ──────────────────────────────────────────────────
  router.get('/workflows/:id', async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    log.info('Fetching workflow', { workflowId: id });

    const wf = await db.query.workflowRun.findFirst({
      where: and(eq(workflowRun.id, id), isNull(workflowRun.deletedAt)),
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
      log.warn('User does not have access to workflow tenant', {
        userId,
        workflowId: id,
      });
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
      ? await db.query.transcript.findFirst({
          where: eq(transcript.id, transcriptId),
        })
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

    const wfOutput = (wf.output as Record<string, unknown> | null) ?? {};
    const errorMessage = typeof wfOutput.errorMessage === 'string' ? wfOutput.errorMessage : null;

    return c.json({
      id,
      kind: wf.kind,
      status: mapDbStatusToSessionStatus(wf.status),
      currentStep,
      companyName: (wf.input as WorkflowInput)?.companyName ?? null,
      stepConfig,
      steps,
      errorMessage,
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
      where: and(eq(workflowRun.id, id), isNull(workflowRun.deletedAt)),
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
      log.warn('User does not have access to workflow tenant', {
        userId,
        workflowId: id,
      });
      return c.json({ error: 'Workflow not found' }, 404);
    }
    if (!isWorkflowOwner(wf, userContext)) {
      log.warn('Caller is not the workflow owner', { userId, workflowId: id });
      return c.json({ error: 'Forbidden' }, 403);
    }

    const step = body.step ?? deriveCurrentStepForWorkflow(wf.status, wf.kind);

    if (isResourceEnrichmentKind(wf.kind)) {
      try {
        if (step === 'enrich') {
          const source = await resolveStepInferenceSource(
            db,
            userContext.tenantId,
            userContext.principalId,
            wf.kind,
            'enrich'
          );
          if (!source) {
            return c.json({ error: 'No LLM credential configured for the enrich step.' }, 400);
          }
          // Optimistically claim the run (running → generating) so a duplicate
          // request cannot double-fire the fan-out. `generating` already maps to
          // the enrich step and is recoverable via resolveResetStatus if it wedges.
          const claimed = await db
            .update(workflowRun)
            .set({ status: 'generating' })
            .where(and(eq(workflowRun.id, id), eq(workflowRun.status, 'running')))
            .returning();
          if (claimed.length === 0) {
            return c.json({ error: 'Enrichment already in progress or run not ready' }, 409);
          }
          // Run the fan-out in the background and return promptly; a large catalog
          // would otherwise hold the request past the proxy idle timeout. The
          // client observes completion by polling the run status.
          void runResourceEnrichmentEnrich(
            db,
            id,
            userContext,
            source,
            DEFAULT_STEP_MAX_OUTPUT_TOKENS.generate
          ).catch(async (err) => {
            log.error('Resource enrichment enrich failed', {
              workflowId: id,
              error: err instanceof Error ? err : new Error(String(err)),
            });
            await db.update(workflowRun).set({ status: 'failed' }).where(eq(workflowRun.id, id));
          });
          return c.json({ status: 'generating' }, 202);
        }
        if (step === 'export') {
          if (wf.status !== 'reviewing') {
            return c.json({ error: 'Export is only available once selections are ready' }, 409);
          }
          const result = await runResourceEnrichmentExport(db, id, userContext);
          return c.json(result);
        }
        return c.json({ error: `Unsupported step for ${wf.kind}: ${step}` }, 400);
      } catch (err) {
        if (err instanceof ResourceEnrichmentError) {
          return c.json({ error: err.message }, err.status);
        }
        throw err;
      }
    }

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
        if (wf.kind === 'presentation-generation') {
          const pSource = await resolveStepInferenceSource(
            db,
            userContext.tenantId,
            userContext.principalId,
            wf.kind,
            'generate'
          );
          if (pSource) {
            void runPresentationGenerate(db, id, userContext.tenantId, pSource).catch(
              (err: unknown) => {
                log.error('Presentation generate pipeline failed', {
                  workflowId: id,
                  error: String(err),
                });
              }
            );
            return c.json({ status: 'generating' }, 202);
          }
        }
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
            ownerPrincipalId: userContext.principalId,
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
        if (wf.kind === 'presentation-generation') {
          const pSource = await resolveStepInferenceSource(
            db,
            userContext.tenantId,
            userContext.principalId,
            wf.kind,
            'generate'
          );
          if (pSource) {
            void runPresentationGenerate(db, id, userContext.tenantId, pSource).catch(
              (err: unknown) => {
                log.error('Presentation generate pipeline failed', {
                  workflowId: id,
                  error: String(err),
                });
              }
            );
            return c.json({ status: 'generating' }, 202);
          }
        }
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
            ownerPrincipalId: userContext.principalId,
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
        if (wf.kind === 'presentation-generation') {
          const pSource = await resolveStepInferenceSource(
            db,
            userContext.tenantId,
            userContext.principalId,
            wf.kind,
            'generate'
          );
          if (pSource) {
            void runPresentationGenerate(db, id, userContext.tenantId, pSource).catch(
              (err: unknown) => {
                log.error('Presentation generate pipeline failed', {
                  workflowId: id,
                  error: String(err),
                });
              }
            );
            return c.json({ status: 'generating' }, 202);
          }
        }
        return c.json({ status: 'running' });
      }

      return c.json({ error: 'transcriptSource must be paste, granola, or artifact' }, 400);
    }

    if (wf.kind === 'reddit-opportunity-scanner') {
      if (step === 'analyze') {
        if (wf.status !== 'pending' && wf.status !== 'failed') {
          return c.json(
            { error: 'Analyze step can only be submitted from pending or failed status' },
            409
          );
        }
        const source = await resolveStepInferenceSource(
          db,
          userContext.tenantId,
          userContext.principalId,
          wf.kind,
          'analyze'
        );
        if (!source) {
          return c.json({ error: 'No LLM credential configured for the analyze step' }, 400);
        }
        await db.update(workflowRun).set({ status: 'analyzing' }).where(eq(workflowRun.id, id));
        void runRedditOpportunityAnalyze(
          db,
          id,
          userContext,
          source,
          DEFAULT_STEP_MAX_OUTPUT_TOKENS.analyze
        ).catch(async (err) => {
          const errorMessage = err instanceof Error ? err.message : String(err);
          await reportLoggedError(log, 'Reddit opportunity analyze failed', err, {
            workflowId: id,
          });
          await db
            .update(workflowRun)
            .set({ status: 'failed', output: { errorMessage } })
            .where(eq(workflowRun.id, id));
        });
        return c.json({ status: 'analyzing' }, 202);
      }
      if (step === 'scan') {
        if (wf.status !== 'reviewing') {
          return c.json({ error: 'Scan step can only be submitted from reviewing status' }, 409);
        }
        const source = await resolveStepInferenceSource(
          db,
          userContext.tenantId,
          userContext.principalId,
          wf.kind,
          'scan'
        );
        if (!source) {
          return c.json({ error: 'No LLM credential configured for the scan step' }, 400);
        }
        await db.update(workflowRun).set({ status: 'running' }).where(eq(workflowRun.id, id));
        void runRedditOpportunityScan(
          db,
          id,
          userContext,
          source,
          DEFAULT_STEP_MAX_OUTPUT_TOKENS.generate
        ).catch(async (err) => {
          const errorMessage = err instanceof Error ? err.message : String(err);
          await reportLoggedError(log, 'Reddit opportunity scan failed', err, { workflowId: id });
          await db
            .update(workflowRun)
            .set({ status: 'reviewing', output: { errorMessage } })
            .where(eq(workflowRun.id, id));
        });
        return c.json({ status: 'running' }, 202);
      }
      return c.json({ error: `Invalid step for reddit workflow: ${step}` }, 400);
    }

    if (step === 'execute' && wf.kind === 'blind-ab-comparison') {
      const currentInput = (wf.input as Record<string, unknown>) ?? {};
      const providers = currentInput['providers'] as
        | Array<{
            credentialId: string;
            providerName: string;
            providerPlugin: string;
            model?: string;
            skillIds: string[];
          }>
        | undefined;
      const inputDef = currentInput['input'] as
        | { source: string; text?: string; artifactId?: string }
        | undefined;
      const systemPrompt =
        typeof currentInput['systemPrompt'] === 'string' ? currentInput['systemPrompt'] : undefined;

      if (!providers) {
        return c.json({ error: 'At least two providers are required' }, 400);
      }
      const executeProviderValidation = validateAbComparisonProviders(providers);
      if (!executeProviderValidation.valid) {
        return c.json({ error: executeProviderValidation.error }, 400);
      }
      if (!inputDef) {
        return c.json({ error: 'Input definition is required' }, 400);
      }

      await db.update(workflowRun).set({ status: 'running' }).where(eq(workflowRun.id, id));

      void runAbComparisonExecution(
        db,
        id,
        userContext,
        providers,
        inputDef,
        systemPrompt,
        async (option) =>
          resolveCredentialInferenceSource(
            db,
            userContext.tenantId,
            option.credentialId,
            option.model
          )
      ).catch((err) => {
        log.error('A/B comparison execution failed', {
          workflowId: id,
          error: err instanceof Error ? err.message : String(err),
        });
        void db.update(workflowRun).set({ status: 'failed' }).where(eq(workflowRun.id, id));
      });

      return c.json({ status: 'running' }, 202);
    }

    if (step === 'persist' && wf.kind === 'blind-ab-comparison') {
      const currentInput = (wf.input as Record<string, unknown>) ?? {};
      const branches = currentInput['branches'] as
        | Array<{
            id: string;
            option: { providerName: string; model?: string; providerPlugin: string };
            output?: string;
            status: string;
            errorMessage?: string;
          }>
        | undefined;
      // Merge request body into currentInput so the API contract is respected
      const bodyRanking = body['ranking'];
      const bodyFeedback = body['feedback'];
      const ranking = (bodyRanking !== undefined ? bodyRanking : currentInput['ranking']) as
        | { branchIds: string[]; feedback?: Record<string, string> }
        | undefined;
      const feedback = (bodyFeedback !== undefined ? bodyFeedback : currentInput['feedback']) as
        | Record<string, string>
        | undefined;

      if (!branches || branches.length === 0) {
        return c.json({ error: 'No branches to persist' }, 400);
      }

      // Persist merged ranking/feedback back into the workflow input so
      // subsequent reads see the same data.
      if (bodyRanking !== undefined || bodyFeedback !== undefined) {
        const mergedInput = { ...currentInput };
        if (bodyRanking !== undefined) mergedInput['ranking'] = bodyRanking;
        if (bodyFeedback !== undefined) mergedInput['feedback'] = bodyFeedback;
        await db.update(workflowRun).set({ input: mergedInput }).where(eq(workflowRun.id, id));
      }

      const result = await persistAbComparisonResults(
        db,
        id,
        userContext,
        branches,
        ranking,
        feedback
      );
      return c.json({ status: 'done', artifactIds: result.artifactIds });
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
        log.warn('No workflow LLM credential configured', {
          tenantId: userContext.tenantId,
        });
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
        log.warn('Generate called without pain point selection', {
          workflowId: id,
        });
        return c.json({ error: 'Select at least one pain point to generate collateral.' }, 400);
      }
      if (!Array.isArray(body.collateralTypes) || body.collateralTypes.length === 0) {
        log.warn('Generate called without collateral type selection', {
          workflowId: id,
        });
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
      where: and(eq(workflowRun.id, id), isNull(workflowRun.deletedAt)),
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

    const wf = await db.query.workflowRun.findFirst({
      where: and(eq(workflowRun.id, id), isNull(workflowRun.deletedAt)),
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

  // ─── Write the reviewer's pick into a selection artifact ─────────────
  // Selection content is immutable + versioned like any artifact, so a pick is a
  // new version: merge `chosen` into the content and append an artifact_version
  // row. `setSelectionChosen` validates every index against the artifact's own
  // options and throws on a bad pick, which surfaces as a 400.
  router.patch('/workflows/:id/artifacts/:artifactId/selection', async (c) => {
    const id = c.req.param('id');
    const artifactId = c.req.param('artifactId');
    const userId = c.get('userId');
    const body = (await c.req.json().catch(() => ({}))) as { chosen?: unknown };
    const chosen = body.chosen;
    if (typeof chosen !== 'object' || chosen === null || Array.isArray(chosen)) {
      return c.json(
        {
          error: 'chosen must be an object mapping field name to option index',
        },
        400
      );
    }
    if (
      !Object.values(chosen as Record<string, unknown>).every(
        (v) => typeof v === 'number' && Number.isInteger(v)
      )
    ) {
      return c.json({ error: 'chosen values must be integer option indexes' }, 400);
    }
    const chosenMap = chosen as Record<string, number>;

    const wf = await db.query.workflowRun.findFirst({
      where: and(eq(workflowRun.id, id), isNull(workflowRun.deletedAt)),
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

    const art = await db.query.artifact.findFirst({
      where: and(eq(artifact.id, artifactId), eq(artifact.sessionId, id)),
    });
    if (!art) return c.json({ error: 'Artifact not found' }, 404);
    if (art.kind !== SELECTION_ARTIFACT_KIND) {
      return c.json({ error: 'Artifact is not a selection' }, 400);
    }

    // Fast-fail the pick against the current content for a clean 400; the
    // authoritative merge happens inside the transaction against a row-locked
    // re-read so two concurrent picks on different fields can't clobber.
    try {
      setSelectionChosen(art.content, chosenMap);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Invalid selection' }, 400);
    }

    let conflict = false;
    const updated = await db.transaction(async (tx) => {
      const [fresh] = await tx
        .select({ content: artifact.content })
        .from(artifact)
        .where(eq(artifact.id, artifactId))
        .for('update');
      if (!fresh) return undefined;

      let nextContent: string;
      try {
        nextContent = setSelectionChosen(fresh.content, chosenMap);
      } catch {
        conflict = true;
        return undefined;
      }

      const maxVersionResult = await tx
        .select({ maxVersion: max(artifactVersion.version) })
        .from(artifactVersion)
        .where(eq(artifactVersion.artifactId, artifactId));
      const nextVersion = (maxVersionResult[0]?.maxVersion ?? 0) + 1;

      const [row] = await tx
        .update(artifact)
        .set({ content: nextContent, version: nextVersion })
        .where(eq(artifact.id, artifactId))
        .returning();

      await tx.insert(artifactVersion).values({
        artifactId,
        version: nextVersion,
        title: art.title,
        content: nextContent,
        authorId: userContext.principalId,
      });

      return row;
    });

    if (conflict) {
      return c.json({ error: 'Selection changed concurrently; please retry' }, 409);
    }
    if (!updated) return c.json({ error: 'Artifact not found' }, 404);
    return c.json(serializeArtifact(updated));
  });

  router.patch('/workflows/:id/artifacts/:artifactId/reddit-scan', async (c) => {
    const id = c.req.param('id');
    const artifactId = c.req.param('artifactId');
    const userId = c.get('userId');
    const body = (await c.req.json().catch(() => ({}))) as {
      recommendations?: unknown;
      scanConfig?: unknown;
    };

    const wf = await db.query.workflowRun.findFirst({
      where: and(eq(workflowRun.id, id), isNull(workflowRun.deletedAt)),
    });
    if (!wf) return c.json({ error: 'Workflow not found' }, 404);
    if (wf.kind !== 'reddit-opportunity-scanner' || wf.status !== 'reviewing') {
      return c.json({ error: 'Reddit scan review is only editable while reviewing' }, 409);
    }

    const { context: userContext, forbidden } = await getRequestedUserContext(
      db,
      userId,
      wf.tenantId
    );
    if (forbidden || !userContext) return c.json({ error: 'Workflow not found' }, 404);
    if (!isWorkflowOwner(wf, userContext)) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const art = await db.query.artifact.findFirst({
      where: and(eq(artifact.id, artifactId), eq(artifact.sessionId, id)),
    });
    if (!art) return c.json({ error: 'Artifact not found' }, 404);
    if (art.kind !== REDDIT_OPPORTUNITY_SCAN_ARTIFACT_KIND) {
      return c.json({ error: 'Artifact is not a reddit opportunity scan' }, 400);
    }

    let nextContent: string;
    try {
      nextContent = mergeRedditScanReview(art.content, {
        recommendations: body.recommendations,
        scanConfig: body.scanConfig,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Invalid review patch' }, 400);
    }

    try {
      const updated = await updateRedditScanArtifactContent(
        db,
        id,
        artifactId,
        userContext.principalId,
        nextContent
      );
      return c.json(serializeArtifact(updated));
    } catch (err) {
      if (err instanceof RedditOpportunityScannerError) {
        return c.json({ error: err.message }, err.status);
      }
      throw err;
    }
  });

  router.patch('/workflows/:id/artifacts/:artifactId/reddit-opportunity', async (c) => {
    const id = c.req.param('id');
    const artifactId = c.req.param('artifactId');
    const userId = c.get('userId');
    const body = (await c.req.json().catch(() => ({}))) as {
      opportunityId?: string;
      status?: string;
    };
    const opportunityId = typeof body.opportunityId === 'string' ? body.opportunityId : '';
    const status = typeof body.status === 'string' ? body.status : '';
    if (!opportunityId || !status) {
      return c.json({ error: 'opportunityId and status are required' }, 400);
    }

    const wf = await db.query.workflowRun.findFirst({
      where: and(eq(workflowRun.id, id), isNull(workflowRun.deletedAt)),
    });
    if (!wf) return c.json({ error: 'Workflow not found' }, 404);

    const { context: userContext, forbidden } = await getRequestedUserContext(
      db,
      userId,
      wf.tenantId
    );
    if (forbidden || !userContext) return c.json({ error: 'Workflow not found' }, 404);
    if (!isWorkflowOwner(wf, userContext)) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const art = await db.query.artifact.findFirst({
      where: and(eq(artifact.id, artifactId), eq(artifact.sessionId, id)),
    });
    if (!art) return c.json({ error: 'Artifact not found' }, 404);
    if (art.kind !== REDDIT_OPPORTUNITY_SCAN_ARTIFACT_KIND) {
      return c.json({ error: 'Artifact is not a reddit opportunity scan' }, 400);
    }

    let nextContent: string;
    try {
      nextContent = updateOpportunityStatus(art.content, opportunityId, status);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Invalid status update' }, 400);
    }

    try {
      const updated = await updateRedditScanArtifactContent(
        db,
        id,
        artifactId,
        userContext.principalId,
        nextContent
      );
      return c.json(serializeArtifact(updated));
    } catch (err) {
      if (err instanceof RedditOpportunityScannerError) {
        return c.json({ error: err.message }, err.status);
      }
      throw err;
    }
  });

  // ─── Update company name ────────────────────────────────────────────
  router.patch('/workflows/:id/company', async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    const body = (await c.req.json().catch(() => ({}))) as {
      companyName?: string;
    };

    const companyName =
      typeof body.companyName === 'string' ? body.companyName.trim().slice(0, 200) : null;

    const wf = await db.query.workflowRun.findFirst({
      where: and(eq(workflowRun.id, id), isNull(workflowRun.deletedAt)),
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

  // ─── Regenerate a single artifact with optional feedback ────────────
  router.post('/workflows/:id/artifacts/:artifactId/regenerate', async (c) => {
    const workflowId = c.req.param('id');
    const artifactId = c.req.param('artifactId');
    const userId = c.get('userId');
    const body = (await c.req.json().catch(() => ({}))) as { feedback?: string };
    const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : undefined;

    const wf = await db.query.workflowRun.findFirst({
      where: and(eq(workflowRun.id, workflowId), isNull(workflowRun.deletedAt)),
    });
    if (!wf) return c.json({ error: 'Workflow not found' }, 404);

    const { context: userContext, forbidden } = await getRequestedUserContext(
      db,
      userId,
      wf.tenantId
    );
    if (forbidden || !userContext) return c.json({ error: 'Workflow not found' }, 404);
    if (!isWorkflowOwner(wf, userContext)) return c.json({ error: 'Forbidden' }, 403);

    const art = await db.query.artifact.findFirst({
      where: eq(artifact.id, artifactId),
    });
    if (!art || art.sessionId !== workflowId) return c.json({ error: 'Artifact not found' }, 404);

    const input = wf.input as WorkflowInput;
    const transcriptRow = input?.transcriptId
      ? await db.query.transcript.findFirst({ where: eq(transcript.id, input.transcriptId) })
      : null;
    if (!transcriptRow) return c.json({ error: 'Transcript not found' }, 422);

    const point = art.painPointId
      ? await db.query.painPoint.findFirst({ where: eq(painPoint.id, art.painPointId) })
      : null;
    if (!point) return c.json({ error: 'Pain point not found' }, 422);

    const source = await resolveStepInferenceSource(
      db,
      userContext.tenantId,
      userContext.principalId,
      wf.kind,
      'generate'
    );
    if (!source) return c.json({ error: 'No LLM credential configured for generate step' }, 400);

    let generated: Awaited<ReturnType<typeof generateCollateralWithLLM>>;
    try {
      generated = await generateCollateralWithLLM(
        workflowId,
        transcriptRow.content,
        point,
        art.kind,
        source,
        undefined,
        0,
        feedback || undefined
      );
    } catch (err) {
      log.error('Artifact regeneration failed', {
        workflowId,
        artifactId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'Generation failed' }, 500);
    }

    const [updated] = await db
      .update(artifact)
      .set({
        title: generated.title,
        content: generated.body,
        status: 'draft',
        version: art.version + 1,
      })
      .where(eq(artifact.id, artifactId))
      .returning();

    return c.json(updated, 202);
  });

  // ─── Delete workflow ────────────────────────────────────────────────
  router.delete('/workflows/:id', async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');

    const wf = await db.query.workflowRun.findFirst({
      where: and(eq(workflowRun.id, id), isNull(workflowRun.deletedAt)),
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

    await db.update(workflowRun).set({ deletedAt: new Date() }).where(eq(workflowRun.id, id));

    log.info('Workflow archived', { workflowId: id, tenantId: wf.tenantId });
    return c.json({ id, deleted: true });
  });

  // ─── Update step config ─────────────────────────────────────────────
  router.patch('/workflows/:id/step-config', async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    const body = (await c.req.json().catch(() => ({}))) as {
      stepConfig?: unknown;
    };

    if (!body.stepConfig || typeof body.stepConfig !== 'object' || Array.isArray(body.stepConfig)) {
      log.warn('Missing or invalid stepConfig in request body', {
        workflowId: id,
      });
      return c.json({ error: 'stepConfig object is required' }, 400);
    }

    // Validate that all keys are configurable step names
    const keys = Object.keys(body.stepConfig as object);
    const invalidKeys = keys.filter((k) => !CONFIGURABLE_STEPS.includes(k as ConfigurableStep));
    if (invalidKeys.length > 0) {
      log.warn('stepConfig contains unknown step keys', {
        workflowId: id,
        invalidKeys,
      });
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
      where: and(eq(workflowRun.id, id), isNull(workflowRun.deletedAt)),
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
        log.warn('agentId not found in tenant', {
          workflowId: id,
          unauthorized,
        });
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

    log.info('Step config updated', {
      workflowId: id,
      steps: Object.keys(validatedConfig),
    });
    return c.json({ id, stepConfig: validatedConfig });
  });

  // ─── Update workflow step data (ranking, feedback, etc.) ───────────────
  router.patch('/workflows/:id/step-data', async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    const wf = await db.query.workflowRun.findFirst({
      where: and(eq(workflowRun.id, id), isNull(workflowRun.deletedAt)),
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

    const currentInput = (wf.input as Record<string, unknown>) ?? {};
    const updatedInput: Record<string, unknown> = { ...currentInput };

    if (body['ranking'] !== undefined) {
      const ranking = body['ranking'];
      if (
        typeof ranking !== 'object' ||
        ranking === null ||
        Array.isArray(ranking) ||
        !Array.isArray((ranking as Record<string, unknown>)['branchIds'])
      ) {
        return c.json({ error: 'ranking must be an object with branchIds array' }, 400);
      }
      updatedInput['ranking'] = ranking;
    }
    if (body['feedback'] !== undefined) {
      const feedback = body['feedback'];
      if (typeof feedback !== 'object' || feedback === null || Array.isArray(feedback)) {
        return c.json({ error: 'feedback must be an object' }, 400);
      }
      updatedInput['feedback'] = feedback;
    }

    await db.update(workflowRun).set({ input: updatedInput }).where(eq(workflowRun.id, id));

    log.info('Workflow step data updated', { workflowId: id, keys: Object.keys(body) });
    return c.json({ id, updated: Object.keys(body) });
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
