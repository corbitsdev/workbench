import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { getLogger } from '@intx/log';
import {
  resolveCredentialRequirement,
  resolveCredentialById,
  resolveInstanceSources,
  schema as intxSchema,
} from '@intx/db';
import type { InferenceSource } from '@intx/types/runtime';
import { workflowRegistry } from '@workbench/workflow-core';
import type { WorkflowType, UserContext } from '@workbench/workflow-core';
import { randomUUID } from 'node:crypto';
import { KNOWN_TOOLS } from '../lib/tool-registry';
import type { HubDb } from '../db';
import { workflowRun, enabledWorkflow } from '../db/schema';
import { getConfig } from '../config';
import { runAnalyze } from './workflow-generation';
import { mapDbStatusToSessionStatus } from './workflow-status';

const log = getLogger(['api', 'workflow']);

export { mapDbStatusToSessionStatus };

/** Derive step order from the workflow definition. */
export function getWorkflowStepOrder(kind: string): string[] {
  const def = workflowRegistry.get(kind);
  if (!def) throw new Error(`Workflow definition not found: ${kind}`);
  return def.steps.map((s) => s.name);
}

/** Return the first step after 'intake' for a given workflow. */
export function getFirstRunnableStep(kind: string): string {
  const steps = getWorkflowStepOrder(kind);
  const intakeIndex = steps.indexOf('intake');
  const next = steps[intakeIndex + 1];
  if (!next) throw new Error(`Workflow ${kind} has no step after intake`);
  return next;
}

/** Map a DB status to the conceptual step name for a given workflow. */
export function deriveCurrentStepForWorkflow(status: string, kind: string): string {
  const steps = getWorkflowStepOrder(kind);
  if (kind === 'presentation-generation') {
    switch (status) {
      case 'pending':
      case 'failed':
        return steps[0]!;
      case 'analyzing':
        return steps[1]!;
      case 'running':
      case 'generating':
      case 'reviewing':
      case 'done':
        return steps[2]!;
      default:
        throw new Error(`Unknown workflow status: ${status}`);
    }
  }
  const firstPostIntake = steps[1];
  const lastStep = steps[steps.length - 1];
  if (!firstPostIntake || !lastStep) {
    throw new Error(`Workflow ${kind} has too few steps to derive current step`);
  }
  switch (status) {
    case 'pending':
    case 'analyzing':
      return firstPostIntake;
    case 'running':
    case 'generating':
    case 'reviewing':
    case 'done':
      return lastStep;
    case 'failed':
      return 'intake';
    default:
      throw new Error(`Unknown workflow status: ${status}`);
  }
}

export function deriveWorkflowDisplayName(
  workflowKind: string | undefined,
  input: WorkflowInput | undefined
): string | null {
  const workflow = workflowKind ? workflowRegistry.get(workflowKind) : undefined;
  const title = workflow?.deriveRunTitle?.(input as Record<string, unknown> | undefined);
  if (title) return title;
  const companyName = typeof input?.companyName === 'string' ? input.companyName.trim() : '';
  return companyName || null;
}

/** Generic background step trigger. Dispatches to the domain-specific
 *  executor based on step name. */
export async function triggerStep(
  db: HubDb,
  id: string,
  userContext: UserContext,
  step: string,
  source: InferenceSource,
  maxOutputTokens?: number
) {
  try {
    const response = await dispatchStep(db, id, userContext, step, source, maxOutputTokens);
    if (response.status >= 400) {
      log.error('Background step failed', { workflowId: id, step, status: response.status });
      await db.update(workflowRun).set({ status: 'failed' }).where(eq(workflowRun.id, id));
    }
  } catch (err) {
    log.error('Background step threw exception', {
      workflowId: id,
      step,
      error: err instanceof Error ? err.message : String(err),
    });
    await db.update(workflowRun).set({ status: 'failed' }).where(eq(workflowRun.id, id));
  }
}

/** Dispatch a step to its executor. Only 'analyze' supports auto-trigger
 *  today; 'generate' requires user input (pain-point selection). */
export async function dispatchStep(
  db: HubDb,
  id: string,
  userContext: UserContext,
  step: string,
  source: InferenceSource,
  maxOutputTokens?: number
): Promise<Response> {
  if (step === 'analyze') {
    return runAnalyze(db, id, userContext, source, undefined, maxOutputTokens);
  }
  log.warn('No auto-executor for step', { workflowId: id, step });
  return Response.json({ error: `Step ${step} does not support auto-trigger` }, { status: 400 });
}

export const CONFIGURABLE_STEPS = ['analyze', 'generate'] as const;
export type ConfigurableStep = (typeof CONFIGURABLE_STEPS)[number];

export interface StepConfig {
  agentId?: string;
  toolIds?: string[];
  maxOutputTokens?: number;
}

export interface WorkflowStepConfig {
  analyze?: StepConfig;
  generate?: StepConfig;
  improve?: StepConfig;
}

export interface WorkflowInput {
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
export async function resolveGranolaApiKey(db: HubDb, tenantId: string): Promise<string | null> {
  const resolved = await resolveCredentialRequirement(
    db,
    tenantId,
    GRANOLA_CREDENTIAL_REQUIREMENT,
    null,
    null
  );
  if (!resolved) return null;

  return resolved.secret;
}

/** Build an InferenceSource from a resolved credential's provider row + plaintext secret. */
export function buildInferenceSource(
  providerRow: { plugin: string; metadata: unknown },
  secret: string
): InferenceSource | null {
  const meta = providerRow.metadata as { baseURL?: string; model?: string } | null;
  if (!meta?.baseURL || !meta.model) return null;

  const apiKey = secret;

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

/** Read the per-step assignments stored on the workbench install record.
 *  Prefers a per-user row over a tenant-scoped (principalId IS NULL) row so
 *  that per-user overrides still work if ever introduced. */
export async function getWorkflowAssignments(
  db: HubDb,
  tenantId: string,
  principalId: string,
  kind: string
): Promise<WorkflowAssignments> {
  const rows = await db.query.enabledWorkflow.findMany({
    where: and(
      eq(enabledWorkflow.tenantId, tenantId),
      or(eq(enabledWorkflow.principalId, principalId), isNull(enabledWorkflow.principalId)),
      eq(enabledWorkflow.kind, kind)
    ),
  });
  // Prefer per-user row (principalId set) over tenant-scoped fallback.
  const row = rows.find((r) => r.principalId !== null) ?? rows[0];
  const raw = (row?.assignments ?? null) as WorkflowAssignments | null;
  return raw ?? {};
}

/**
 * Resolve the inference source for a workflow step.
 * Uses the workflow definition's credential requirements (resolved via Interchange's
 * credential system). Per-step assignments are checked first as an optional override.
 */
export async function resolveStepInferenceSource(
  db: HubDb,
  tenantId: string,
  principalId: string,
  kind: string,
  step: string
): Promise<InferenceSource | null> {
  const assignments = await getWorkflowAssignments(db, tenantId, principalId, kind);
  const credentialIds = assignments[step]?.credentialIds ?? [];
  for (const credentialId of credentialIds) {
    const cred = await resolveCredentialById(db, tenantId, credentialId);
    if (!cred) continue;
    const providerRow = await db.query.provider.findFirst({
      where: eq(intxSchema.provider.id, cred.providerId),
    });
    if (!providerRow) continue;
    const source = buildInferenceSource(providerRow, cred.secret);
    if (source) return source;
  }

  const workflowDef = workflowRegistry.get(kind);
  const stepDef = workflowDef?.steps.find((s) => s.name === step);
  const req = stepDef?.credentialRequirements?.find((r) => r.providerName !== 'granola');
  if (!req) return null;

  // resolveCredentialRequirement throws when more than one active credential
  // matches with no name to disambiguate. Treat that as "unresolved" so the
  // caller returns a clear 400 (configure the credential) instead of a 500.
  let resolved;
  try {
    resolved = await resolveCredentialRequirement(db, tenantId, req, null, null);
  } catch (err) {
    log.warn('Workflow LLM credential resolution failed', {
      tenantId,
      kind,
      step,
      providerName: req.providerName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!resolved) return null;

  const providerRow = await db.query.provider.findFirst({
    where: eq(intxSchema.provider.id, resolved.providerId),
  });
  if (!providerRow) return null;

  return buildInferenceSource(providerRow, resolved.secret);
}

/**
 * Resolve the inference source for a step that has been assigned to a specific
 * agent. The assigned agent already declares its own inference provider via its
 * credential requirements, so an agent-mode step needs only access to the agent
 * in the tenant — not a separate per-step inference credential.
 *
 * `agentInstanceId` is an agent *instance* id (what the step-config UI stores);
 * we look up the instance to find its agent definition and resolve the agent's
 * inference sources. Secrets are stored plaintext at the app layer (encryption
 * is handled at rest by storage), so the resolved source is used as-is.
 */
export async function resolveAgentStepInferenceSource(
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

  return raw;
}

/**
 * Resolve the Granola API key for a given workflow step from its install-time
 * assignment. Falls back to the tenant-level Granola credential.
 */
export async function resolveStepGranolaApiKey(
  db: HubDb,
  tenantId: string,
  principalId: string,
  kind: string,
  step = 'intake'
): Promise<string | null> {
  const assignments = await getWorkflowAssignments(db, tenantId, principalId, kind);
  const credentialIds = assignments[step]?.credentialIds ?? [];
  for (const credentialId of credentialIds) {
    const cred = await resolveCredentialById(db, tenantId, credentialId);
    if (!cred) continue;
    const providerRow = await db.query.provider.findFirst({
      where: eq(intxSchema.provider.id, cred.providerId),
    });
    if (providerRow?.name === 'granola') {
      return cred.secret;
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
export async function validateAssignments(
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

    // Resolve assigned credentials, then look up all their providers in a single
    // query instead of one per credential.
    const resolvedCredentials: Array<{ credentialId: string; providerId: string }> = [];
    for (const credentialId of credentialIds) {
      const cred = await resolveCredentialById(db, tenantId, credentialId);
      if (!cred) {
        return { ok: false, error: `Credential not found in this workbench: ${credentialId}` };
      }
      resolvedCredentials.push({ credentialId, providerId: cred.providerId });
    }
    const providerIds = resolvedCredentials.map((c) => c.providerId);
    const providerRows =
      providerIds.length > 0
        ? await db.query.provider.findMany({
            where: inArray(intxSchema.provider.id, providerIds),
            columns: { id: true, name: true },
          })
        : [];
    const providerNameById = new Map(providerRows.map((p) => [p.id, p.name]));
    const assignedProviders = new Set(
      resolvedCredentials
        .map((c) => providerNameById.get(c.providerId))
        .filter((name): name is string => typeof name === 'string')
    );

    // Only enforce credential requirements that can't be auto-resolved at runtime.
    // Requirements with source 'tenant' are resolved by Interchange's credential
    // system when the workflow runs — no explicit assignment needed at install time.
    for (const req of step.credentialRequirements) {
      if (req.source === 'tenant') continue;
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

export async function getUserContext(db: HubDb, userId: string): Promise<UserContext | null> {
  // Resolve the caller's working context in the shared global org tenant
  // (CL-1452 cutover). Was the per-user `user-${userId}` personal tenant; now
  // every same-domain user is a member principal in the one global tenant.
  const { slug } = getConfig().globalTenant;
  const globalTenant = await db.query.tenant.findFirst({
    where: eq(intxSchema.tenant.slug, slug),
  });

  if (!globalTenant) {
    log.error('Global tenant not found — is it seeded?', { slug });
    return null;
  }

  const principal = await db.query.principal.findFirst({
    where: and(
      eq(intxSchema.principal.tenantId, globalTenant.id),
      eq(intxSchema.principal.kind, 'user'),
      eq(intxSchema.principal.refId, userId)
    ),
  });

  if (!principal) {
    log.error('Member principal not found for user in global tenant', {
      userId,
      tenantId: globalTenant.id,
    });
    return null;
  }

  return {
    tenantId: globalTenant.id,
    principalId: principal.id,
  };
}

export async function getRequestedUserContext(
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

/**
 * A workflow belongs to the principal that created it. Tenant membership alone
 * is not sufficient to mutate it: within a shared tenant any member would
 * otherwise be able to edit, reassign, or delete another member's workflow.
 *
 * Callers return 403 (not 404) on an ownership failure. This is deliberate and
 * differs from the cross-tenant instance route, which returns 404 to prevent
 * enumeration of instance IDs in *other* tenants. Here the caller is already an
 * authenticated member of the workflow's own tenant, so revealing that a
 * sibling-owned workflow exists is not a cross-tenant information leak; 403 is
 * the accurate "you may not act on this" signal.
 */
export function isWorkflowOwner(
  wf: { principalId: string },
  userContext: { principalId: string }
): boolean {
  return wf.principalId === userContext.principalId;
}

// Validates required-field presence against the workflow's input schema. Callers
// may pass a placeholder for fields generated on insert (e.g. transcriptId) to
// validate before persisting — so any future rule here must check presence, not
// the format/identity of such fields.
export function validateWorkflowInput(
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
