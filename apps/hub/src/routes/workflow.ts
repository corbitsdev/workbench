import { Hono } from 'hono';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { getLogger } from '@intx/log';
import {
  resolveCredentialRequirement,
  resolveCredentialById,
  resolveInstanceSources,
  schema as intxSchema,
} from '@intx/db';
import type { InferenceSource } from '@intx/types/runtime';
import { workflowRegistry, flattenStepCredentialRequirements } from '@workbench/workflow-core';
import type { WorkflowType } from '@workbench/workflow-core';
import { isCredentialToolEntry, KNOWN_TOOLS } from '../lib/tool-registry';
import { collateralGenerationWorkflow } from '@workbench/gtm-workflows';
import type { HubDb } from '../db';
import {
  workflowRun,
  transcript,
  painPoint,
  artifact,
  artifactVersion,
  enabledWorkflow,
} from '../db/schema';
import { getNoteWithTranscript, getRecentNotes, transcriptToText } from '../lib/granola';
import { extractPainPoints } from '../lib/extraction';

import { generateCollateralWithLLM } from '../lib/generation';
import { decryptSecret } from '@workbench/hub-crypto';
import { getConfig } from '../config';
import { randomUUID } from 'node:crypto';
const log = getLogger(['api', 'workflow']);

workflowRegistry.register(collateralGenerationWorkflow);

const STEP_ORDER = ['intake', 'analyze', 'generate'] as const;
type StepName = (typeof STEP_ORDER)[number];

function mapDbStatusToSessionStatus(status: string): string {
  const map: Record<string, string> = {
    pending: 'pending',
    analyzing: 'analyzing',
    running: 'generating',
    done: 'done',
    failed: 'failed',
  };
  return map[status] ?? status;
}

const CONFIGURABLE_STEPS = ['analyze', 'generate'] as const;
type ConfigurableStep = (typeof CONFIGURABLE_STEPS)[number];

export interface StepConfig {
  agentId?: string;
  toolIds?: string[];
  maxOutputTokens?: number;
}

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

export interface WorkflowStepConfig {
  analyze?: StepConfig;
  generate?: StepConfig;
  improve?: StepConfig;
}

import type { UserContext } from '@workbench/workflow-core';

interface WorkflowInput {
  transcriptId?: string;
  transcriptSource?: string;
  companyName?: string;
  callTitle?: string;
  stepConfig?: WorkflowStepConfig;
}

const GRANOLA_CREDENTIAL_REQUIREMENT = {
  providerName: 'granola',
  source: 'tenant' as const,
};

/**
 * Resolve the workbench Granola API key from the tenant credential store.
 * Returns null when no Granola credential is configured for the tenant.
 */
async function resolveGranolaApiKey(db: HubDb, tenantId: string): Promise<string | null> {
  const resolved = await resolveCredentialRequirement(
    db,
    tenantId,
    GRANOLA_CREDENTIAL_REQUIREMENT,
    null,
    null
  );
  if (!resolved) return null;

  const { credentialKeys } = getConfig();
  return decryptSecret(credentialKeys, tenantId, resolved.secret);
}

/** Build an InferenceSource from a resolved credential's provider row + encrypted secret. */
function buildInferenceSource(
  tenantId: string,
  providerRow: { plugin: string; metadata: unknown },
  secret: string
): InferenceSource | null {
  const meta = providerRow.metadata as { baseURL?: string; model?: string } | null;
  if (!meta?.baseURL || !meta.model) return null;

  const { credentialKeys } = getConfig();
  const apiKey = decryptSecret(credentialKeys, tenantId, secret);

  return {
    id: `workflow-llm-${randomUUID()}`,
    provider: providerRow.plugin,
    baseURL: meta.baseURL,
    apiKey,
    model: meta.model,
  };
}

// ─── Per-step assignment resolution ──────────────────────────────────

export interface StepAssignment {
  credentialIds: string[];
  toolIds: string[];
}
export type WorkflowAssignments = Record<string, StepAssignment>;

/** Read the per-step assignments stored on the workbench install record. */
async function getWorkflowAssignments(
  db: HubDb,
  tenantId: string,
  kind: string
): Promise<WorkflowAssignments> {
  const row = await db.query.enabledWorkflow.findFirst({
    where: and(eq(enabledWorkflow.tenantId, tenantId), eq(enabledWorkflow.kind, kind)),
  });
  const raw = (row?.assignments ?? null) as WorkflowAssignments | null;
  return raw ?? {};
}

/**
 * Resolve the inference source for a given workflow step from its install-time
 * assignment. Falls back to the tenant name-based resolver when the step has no
 * assigned inference credential (keeps pre-assignment installs working).
 */
async function resolveStepInferenceSource(
  db: HubDb,
  tenantId: string,
  kind: string,
  step: string
): Promise<InferenceSource | null> {
  const assignments = await getWorkflowAssignments(db, tenantId, kind);
  const credentialIds = assignments[step]?.credentialIds ?? [];
  for (const credentialId of credentialIds) {
    const cred = await resolveCredentialById(db, tenantId, credentialId);
    if (!cred) continue;
    const providerRow = await db.query.provider.findFirst({
      where: eq(intxSchema.provider.id, cred.providerId),
    });
    if (!providerRow) continue;
    const source = buildInferenceSource(tenantId, providerRow, cred.secret);
    if (source) return source;
  }
  return null;
}

/**
 * Resolve the inference source for a step that has been assigned to a specific
 * agent. The assigned agent already declares its own inference provider via its
 * credential requirements, so an agent-mode step needs only access to the agent
 * in the tenant — not a separate per-step inference credential.
 *
 * `agentInstanceId` is an agent *instance* id (what the step-config UI stores);
 * we look up the instance to find its agent definition, resolve the agent's
 * inference sources, and decrypt the secret (workbench encrypts at write time,
 * Interchange returns the raw stored value).
 */
async function resolveAgentStepInferenceSource(
  db: HubDb,
  tenantId: string,
  agentInstanceId: string
): Promise<InferenceSource | null> {
  const instance = await db.query.agentInstance.findFirst({
    where: eq(intxSchema.agentInstance.id, agentInstanceId),
  });
  if (!instance) return null;

  const rawSources = await resolveInstanceSources(db, tenantId, {
    agentId: instance.agentId,
    sessionId: instance.sessionId ?? null,
  });
  const raw = rawSources[0];
  if (!raw) return null;

  const { credentialKeys } = getConfig();
  return { ...raw, apiKey: decryptSecret(credentialKeys, tenantId, raw.apiKey) };
}

/**
 * Resolve the Granola API key for a given workflow step from its install-time
 * assignment. Falls back to the tenant-level Granola credential.
 */
async function resolveStepGranolaApiKey(
  db: HubDb,
  tenantId: string,
  kind: string,
  step = 'intake'
): Promise<string | null> {
  const assignments = await getWorkflowAssignments(db, tenantId, kind);
  const credentialIds = assignments[step]?.credentialIds ?? [];
  const { credentialKeys } = getConfig();
  for (const credentialId of credentialIds) {
    const cred = await resolveCredentialById(db, tenantId, credentialId);
    if (!cred) continue;
    const providerRow = await db.query.provider.findFirst({
      where: eq(intxSchema.provider.id, cred.providerId),
    });
    if (providerRow?.name === 'granola') {
      return decryptSecret(credentialKeys, tenantId, cred.secret);
    }
  }
  return resolveGranolaApiKey(db, tenantId);
}

/**
 * Validate a per-step assignments payload against a workflow definition.
 * Ensures every declared credential requirement is satisfied by an assigned
 * tenant credential of the matching provider, and that assigned tools are known
 * and within the step's allowed set. Returns a normalized assignments object.
 */
async function validateAssignments(
  db: HubDb,
  tenantId: string,
  workflow: WorkflowType,
  raw: unknown
): Promise<{ ok: true; assignments: WorkflowAssignments } | { ok: false; error: string }> {
  const input = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  const result: WorkflowAssignments = {};

  for (const step of workflow.steps) {
    const stepValRaw = input[step.name];
    const stepVal = (
      stepValRaw && typeof stepValRaw === 'object' && !Array.isArray(stepValRaw) ? stepValRaw : {}
    ) as Record<string, unknown>;

    const credentialIds = Array.isArray(stepVal.credentialIds)
      ? stepVal.credentialIds.filter((v): v is string => typeof v === 'string')
      : [];
    const toolIds = Array.isArray(stepVal.toolIds)
      ? stepVal.toolIds.filter((v): v is string => typeof v === 'string')
      : [];

    // Tools must be known and within the step's declared allow-list.
    const allowedTools = new Set(step.tools ?? []);
    for (const toolId of toolIds) {
      if (!KNOWN_TOOLS[toolId]) {
        return { ok: false, error: `Unknown tool: ${toolId}` };
      }
      if (!allowedTools.has(toolId)) {
        return { ok: false, error: `Tool ${toolId} is not available for step ${step.name}` };
      }
    }

    // Resolve assigned credentials and index them by provider name.
    const providerNamesForCredential = new Map<string, string>();
    for (const credentialId of credentialIds) {
      const cred = await resolveCredentialById(db, tenantId, credentialId);
      if (!cred) {
        return { ok: false, error: `Credential not found in this workbench: ${credentialId}` };
      }
      const providerRow = await db.query.provider.findFirst({
        where: eq(intxSchema.provider.id, cred.providerId),
      });
      if (providerRow?.name) providerNamesForCredential.set(credentialId, providerRow.name);
    }
    const assignedProviders = new Set(providerNamesForCredential.values());

    // Every declared credential requirement must be satisfied.
    for (const req of step.credentialRequirements) {
      if (!assignedProviders.has(req.providerName)) {
        return {
          ok: false,
          error: `Step ${step.name} requires a ${req.providerName} credential`,
        };
      }
    }

    if (credentialIds.length > 0 || toolIds.length > 0) {
      result[step.name] = { credentialIds, toolIds };
    }
  }

  return { ok: true, assignments: result };
}

async function getUserContext(db: HubDb, userId: string): Promise<UserContext | null> {
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

async function getRequestedUserContext(
  db: HubDb,
  userId: string,
  requestedTenantId?: string | null
): Promise<{ context: UserContext | null; forbidden: boolean }> {
  const userContext = await getUserContext(db, userId);
  if (!userContext) return { context: null, forbidden: false };
  if (!requestedTenantId || requestedTenantId === userContext.tenantId) {
    return { context: userContext, forbidden: false };
  }

  const requestedPrincipal = await db.query.principal.findFirst({
    where: and(
      eq(intxSchema.principal.tenantId, requestedTenantId),
      eq(intxSchema.principal.kind, 'user'),
      eq(intxSchema.principal.refId, userId),
      eq(intxSchema.principal.status, 'active')
    ),
  });
  if (!requestedPrincipal) return { context: null, forbidden: true };

  return {
    context: {
      tenantId: requestedTenantId,
      principalId: requestedPrincipal.id,
    },
    forbidden: false,
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

  // ─── Tool catalog (metadata for the install UI) ──────────────────────
  router.get('/workflows/tools', async (c) => {
    const tools = Object.entries(KNOWN_TOOLS).map(([name, entry]) => ({
      name,
      providerName: isCredentialToolEntry(entry) ? entry.providerName : 'workbench',
      description: entry.definition.description,
    }));
    return c.json(tools);
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
      where: eq(enabledWorkflow.tenantId, userContext.tenantId),
    });

    const result = rows.map((row) => {
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

    const wt = workflowRegistry.get(kind);
    if (!wt) {
      return c.json({ error: `Unknown workflow kind: ${kind}` }, 400);
    }

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
        kind,
        assignments: validation.assignments,
      })
      .onConflictDoUpdate({
        target: [enabledWorkflow.tenantId, enabledWorkflow.kind],
        set: { kind, assignments: validation.assignments },
      })
      .returning();

    log.info('Workflow kind enabled', { tenantId: userContext.tenantId, kind });

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

    log.info('Creating workflow', { source });

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
      const granolaApiKey = await resolveStepGranolaApiKey(db, userContext.tenantId, workflowKind);
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

    const [txRow] = await db
      .insert(transcript)
      .values({ content, source: workflowSource })
      .returning();
    if (!txRow) {
      log.error('Failed to create transcript row', { workflowKind });
      return c.json({ error: 'Failed to create transcript' }, 500);
    }

    const workflowInput = { transcriptId: txRow.id, transcriptSource: workflowSource, callTitle };
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
          status: mapDbStatusToSessionStatus(s.status),
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

    const requestedTenantId = c.req.query('tenantId');
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
      return c.json([]);
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

    const directArtifactWhere = and(
      eq(artifact.tenantId, userContext.tenantId),
      eq(artifact.principalId, userContext.principalId)
    );

    const artifacts = await db.query.artifact.findMany({
      where:
        sessions.length > 0
          ? or(
              inArray(
                artifact.sessionId,
                sessions.map((s: (typeof sessions)[number]) => s.id)
              ),
              directArtifactWhere
            )
          : directArtifactWhere,
      orderBy: [desc(artifact.updatedAt)],
    });

    const rows = artifacts.map((a: any) => {
      const session = sessionById.get(a.sessionId);
      return {
        ...serializeArtifact(a),
        sessionName: session
          ? deriveWorkflowDisplayName(session.kind, session.input as WorkflowInput)
          : null,
        sessionStatus: session ? mapDbStatusToSessionStatus(session.status) : null,
      };
    });

    return c.json(rows);
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
      status: mapDbStatusToSessionStatus(wf.status),
      currentStep,
      companyName: (wf.input as WorkflowInput)?.companyName ?? null,
      stepConfig,
      steps: {
        intake: { completed: true, transcriptId: transcriptId ?? null, transcript: tx?.content },
        analyze: {
          completed: wf.status === 'running' || wf.status === 'done',
          painPoints: points.map(serializePainPoint),
        },
        generate: {
          completed: allArtifacts.length > 0,
          artifacts: allArtifacts.map(serializeArtifact),
        },
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
      collateralTypes?: string[];
      artifactId?: string;
      feedback?: string;
      target?: string;
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

    const step = body.step ?? deriveCurrentStep(wf.status);

    if (step === 'analyze' || step === 'generate') {
      // A step runs in one of two modes. Agent mode: the step is assigned a
      // tenant agent, which carries its own inference provider — resolve the
      // source from the agent definition, no per-step credential needed. Inline
      // mode (no assigned agent): resolve the step's configured workflow LLM
      // credential.
      const assignedAgentId = (wf.input as WorkflowInput)?.stepConfig?.[step]?.agentId;
      const source = assignedAgentId
        ? await resolveAgentStepInferenceSource(db, userContext.tenantId, assignedAgentId)
        : await resolveStepInferenceSource(db, userContext.tenantId, wf.kind, step);
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
        (wf.input as WorkflowInput)?.stepConfig?.[step]?.maxOutputTokens ??
        DEFAULT_STEP_MAX_OUTPUT_TOKENS[step];

      if (step === 'analyze') {
        return runAnalyze(db, id, userContext, source, body.feedback, maxOutputTokens);
      }
      // step === 'generate'
      return runGenerate(
        db,
        id,
        body.painPointIds ?? [],
        body.collateralTypes,
        userContext.principalId,
        source,
        maxOutputTokens
      );
    }

    log.warn('Invalid step', { workflowId: id, step });
    return c.json({ error: 'Invalid step' }, 400);
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

    const [row] = await db
      .update(artifact)
      .set({ status })
      .where(and(eq(artifact.id, artifactId), eq(artifact.sessionId, id)))
      .returning();

    if (!row) return c.json({ error: 'Artifact not found' }, 404);
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
    const limit = limitParam ? parseInt(limitParam, 10) : 10;
    const granolaApiKey = kind
      ? await resolveStepGranolaApiKey(db, userContext.tenantId, kind)
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

// ─── Step helpers ───────────────────────────────────────────────────

function deriveCurrentStep(status: string): StepName {
  const map: Record<string, StepName> = {
    pending: 'analyze',
    analyzing: 'analyze',
    running: 'generate',
    done: 'generate',
    failed: 'intake',
  };
  return map[status] ?? 'intake';
}

async function runAnalyze(
  db: HubDb,
  id: string,
  userContext: UserContext,
  source: InferenceSource,
  feedback?: string,
  maxOutputTokens?: number
) {
  log.info('Starting analyze step', { workflowId: id, hasFeedback: Boolean(feedback) });

  const wf = await db.query.workflowRun.findFirst({
    where: eq(workflowRun.id, id),
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
  let extracted: Awaited<ReturnType<typeof extractPainPoints>>['painPoints'];
  let companyName: string | null;
  try {
    const result = await extractPainPoints(id, tx.content, feedback, source, maxOutputTokens);
    extracted = result.painPoints;
    companyName = result.companyName;
  } catch (err) {
    log.error('Pain point extraction failed', {
      workflowId: id,
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { error: 'Analysis failed. Check your LLM credential and try again.' },
      { status: 502 }
    );
  }
  log.info('Pain points extracted', { workflowId: id, count: extracted.length, companyName });

  const currentWf = await db.query.workflowRun.findFirst({
    where: eq(workflowRun.id, id),
  });
  if (!currentWf) {
    log.warn('Workflow deleted before analyze results could be saved', { workflowId: id });
    return Response.json(
      { error: 'Workflow was deleted while analysis was running' },
      { status: 410 }
    );
  }

  await db.delete(painPoint).where(eq(painPoint.sessionId, id));

  const inserted =
    extracted.length > 0 ? await db.insert(painPoint).values(extracted).returning() : [];

  const workflowDefinition = workflowRegistry.get(currentWf.kind);
  const analysisArtifacts = workflowDefinition?.createAnalyzeArtifacts?.({
    input: currentWf.input as Record<string, unknown>,
    painPoints: extracted,
    companyName,
  });
  for (const draft of analysisArtifacts ?? []) {
    await db.insert(artifact).values({
      tenantId: currentWf.tenantId,
      principalId: currentWf.principalId,
      sessionId: id,
      kind: draft.kind,
      title: draft.title,
      content: draft.content,
      status: draft.status ?? 'draft',
      version: draft.version ?? 1,
    });
  }

  const updatedInput: WorkflowInput = { ...(currentWf.input as WorkflowInput) };
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
  db: HubDb,
  id: string,
  painPointIds: string[],
  collateralTypes: string[] | undefined,
  principalId: string,
  source: InferenceSource,
  maxOutputTokens?: number
) {
  const authorId = principalId;
  log.info('Starting generate step', { workflowId: id, painPointCount: painPointIds.length });

  const [points, wf] = await Promise.all([
    db.query.painPoint.findMany({
      where: and(inArray(painPoint.id, painPointIds), eq(painPoint.sessionId, id)),
    }),
    db.query.workflowRun.findFirst({
      where: eq(workflowRun.id, id),
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

  const workflowDefinition = workflowRegistry.get(wf.kind);
  const artifactKinds = workflowDefinition?.selectGenerateArtifactKinds?.(collateralTypes) ?? [
    'email',
    'linkedin',
    'one-pager',
    'battlecard',
  ];

  const results = await Promise.allSettled(
    points.flatMap((p: any) =>
      artifactKinds.map((kind) =>
        generateCollateralWithLLM(id, transcriptContent, p, kind, source, maxOutputTokens).then(
          ({ title, body }) => ({
            tenantId: wf.tenantId,
            principalId: wf.principalId,
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

  const generated = results.flatMap(
    (
      r: PromiseSettledResult<{
        tenantId: string;
        principalId: string;
        sessionId: string;
        painPointId: any;
        kind: string;
        title: string;
        content: string;
        status: string;
        version: number;
      }>
    ) => {
      if (r.status === 'fulfilled') return [r.value];
      log.error('Artifact generation failed for one item', {
        workflowId: id,
        error: String(r.reason),
      });
      return [];
    }
  );

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

  await db.update(workflowRun).set({ status: 'done' }).where(eq(workflowRun.id, id));

  log.info('Generate step complete', { workflowId: id, artifactCount: inserted.length });

  return Response.json({
    id,
    status: 'done',
    currentStep: 'generate',
    steps: {
      generate: { completed: true, artifacts: inserted.map(serializeArtifact) },
    },
  });
}

// ─── Serialization helpers ──────────────────────────────────────────

function deriveWorkflowDisplayName(
  workflowKind: string | undefined,
  input: WorkflowInput | undefined
): string | null {
  const workflow = workflowKind ? workflowRegistry.get(workflowKind) : undefined;
  const title = workflow?.deriveRunTitle?.(input as Record<string, unknown> | undefined);
  if (title) return title;
  const companyName = typeof input?.companyName === 'string' ? input.companyName.trim() : '';
  return companyName || null;
}

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
