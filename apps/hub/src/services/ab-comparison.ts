import { getLogger } from '@intx/log';
import { getSkillById } from '@workbench/agents';
import { runSingleTurnAgent } from '../lib/inference';
import { resolveSkillVersionPrompt } from './skill-library';
import type { RepoStore } from '@intx/hub-sessions';
import type { InferenceSource } from '@intx/types/runtime';
import type { HubDb } from '../db';
import { workflowRun, artifact } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import type {
  AbComparisonProviderOption,
  AbComparisonInput,
  AbComparisonBranch,
  AbComparisonRanking,
} from '@workbench/gtm-workflows';
import type { UserContext } from '@workbench/workflow-core';

const log = getLogger(['ab-workflow']);

const DEFAULT_INFERENCE_TIMEOUT_MS = 180_000;
const MAX_CONCURRENT_BRANCHES = 3;

async function buildBranchSystemPrompt(
  db: HubDb,
  repoStore: RepoStore,
  tenantId: string,
  option: AbComparisonProviderOption,
  systemPrompt: string | undefined
): Promise<string> {
  const sections: string[] = [];
  if (systemPrompt?.trim()) {
    sections.push(systemPrompt.trim());
  }
  for (const skillId of option.skillIds) {
    const skill = getSkillById(skillId);
    if (skill) {
      sections.push(`Skill: ${skill.title}\n\n${skill.content}`);
    }
  }
  const skillVersionPrompts = await Promise.all(
    (option.skillVersionIds ?? []).map((versionId) =>
      resolveSkillVersionPrompt(db, repoStore, tenantId, versionId).then((prompt) => {
        if (!prompt) throw new Error(`Skill version not found or inaccessible: ${versionId}`);
        return prompt;
      })
    )
  );
  sections.push(...skillVersionPrompts);
  for (const skill of option.customSkills ?? []) {
    const title = skill.title.trim();
    const content = skill.content.trim();
    if (title && content) {
      sections.push(`Skill: ${title}\n\n${content}`);
    }
  }
  return sections.join('\n\n---\n\n');
}

function coerceToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Fan out inference calls for every provider option, storing results in the
 * workflow input as branches. Provenance (provider names, model ids) is stripped
 * from the branch output so the downstream comparison is blind.
 */
export async function runAbComparisonExecution(
  db: HubDb,
  repoStore: RepoStore,
  workflowId: string,
  userContext: UserContext,
  options: AbComparisonProviderOption[],
  input: AbComparisonInput,
  systemPrompt: string | undefined,
  resolveSource: (option: AbComparisonProviderOption) => Promise<InferenceSource | null>
): Promise<{ branches: AbComparisonBranch[] }> {
  // Build the user message from the input definition.
  let userMessage: string;
  if (input.source === 'text') {
    userMessage = input.text ?? '';
  } else if (input.source === 'artifact' && input.artifactId) {
    const art = await db.query.artifact.findFirst({
      where: and(eq(artifact.id, input.artifactId), eq(artifact.tenantId, userContext.tenantId)),
    });
    if (!art) {
      throw new Error('Source artifact not found or not accessible');
    }
    userMessage = coerceToString(art.content);
  } else {
    throw new Error('Invalid input definition');
  }

  if (userMessage.trim().length === 0) {
    throw new Error('Input is empty');
  }

  const branches: AbComparisonBranch[] = options.map((option, index) => ({
    id: `br_${index + 1}`,
    option,
    status: 'pending' as const,
  }));

  // Update workflow with branches and status.
  const runBefore = await db.query.workflowRun.findFirst({
    where: eq(workflowRun.id, workflowId),
  });
  if (!runBefore) {
    throw new Error(`Workflow run not found: ${workflowId}`);
  }
  await db
    .update(workflowRun)
    .set({
      status: 'running',
      input: {
        ...runBefore.input,
        branches,
      } as Record<string, unknown>,
    })
    .where(eq(workflowRun.id, workflowId));

  // Fan out with bounded concurrency.
  async function runBranch(branch: AbComparisonBranch) {
    try {
      const source = await resolveSource(branch.option);
      if (!source) {
        branch.status = 'error';
        branch.errorMessage = 'No inference source resolved for this provider';
        return;
      }

      branch.status = 'running';

      const output = await runSingleTurnAgent(
        source,
        await buildBranchSystemPrompt(db, repoStore, userContext.tenantId, branch.option, systemPrompt),
        userMessage,
        `ab-compare-${workflowId}`,
        undefined,
        DEFAULT_INFERENCE_TIMEOUT_MS
      );

      // Strip provenance: the output is stored without any model/provider metadata.
      branch.output = output;
      branch.status = 'done';
    } catch (err) {
      branch.status = 'error';
      branch.errorMessage = err instanceof Error ? err.message : String(err);
      log.error('A/B branch failed', {
        workflowId,
        branchId: branch.id,
        provider: branch.option.providerName,
        error: branch.errorMessage,
      });
    }
  }

  for (let i = 0; i < branches.length; i += MAX_CONCURRENT_BRANCHES) {
    const batch = branches.slice(i, i + MAX_CONCURRENT_BRANCHES);
    await Promise.all(batch.map(runBranch));
  }

  // Persist updated branches.
  const runAfter = await db.query.workflowRun.findFirst({
    where: eq(workflowRun.id, workflowId),
  });
  if (!runAfter) {
    throw new Error(`Workflow run not found at completion: ${workflowId}`);
  }
  await db
    .update(workflowRun)
    .set({
      status: 'reviewing',
      input: {
        ...runAfter.input,
        branches,
      } as Record<string, unknown>,
    })
    .where(eq(workflowRun.id, workflowId));

  return { branches };
}

/**
 * Persist the A/B comparison results as artifacts:
 * 1. A top-level artifact summarizing the run and final ranking.
 * 2. One artifact per branch with provenance revealed in its metadata.
 */
export async function persistAbComparisonResults(
  db: HubDb,
  workflowId: string,
  userContext: UserContext,
  branches: AbComparisonBranch[],
  ranking: AbComparisonRanking | undefined,
  feedback: Record<string, string> | undefined
): Promise<{ artifactIds: string[] }> {
  const artifactIds: string[] = [];

  // Top-level summary artifact.
  const topLevelContent = JSON.stringify(
    {
      kind: 'ab-comparison-result',
      workflowId,
      createdAt: new Date().toISOString(),
      ranking: ranking?.branchIds.map((bid) => {
        const branch = branches.find((b) => b.id === bid);
        return {
          branchId: bid,
          provider: branch?.option.providerName ?? 'unknown',
          model: branch?.option.model ?? 'unknown',
          feedback: feedback?.[bid] ?? null,
        };
      }),
    },
    null,
    2
  );

  const [topLevel] = await db
    .insert(artifact)
    .values({
      tenantId: userContext.tenantId,
      principalId: userContext.principalId,
      ownerPrincipalId: userContext.principalId,
      sessionId: workflowId,
      kind: 'ab-comparison-result',
      title: 'A/B Comparison Results',
      content: topLevelContent,
      status: 'draft',
      version: 1,
    })
    .returning();
  if (topLevel) artifactIds.push(topLevel.id);

  // Per-branch artifacts with provenance revealed.
  for (const branch of branches) {
    if (!branch.output) continue;
    const branchContent = JSON.stringify(
      {
        kind: 'ab-comparison-branch',
        branchId: branch.id,
        provider: branch.option.providerName,
        model: branch.option.model ?? 'unknown',
        plugin: branch.option.providerPlugin,
        output: branch.output,
        feedback: feedback?.[branch.id] ?? null,
        rank: ranking?.branchIds.indexOf(branch.id) ?? -1,
      },
      null,
      2
    );

    const [inserted] = await db
      .insert(artifact)
      .values({
        tenantId: userContext.tenantId,
        principalId: userContext.principalId,
        ownerPrincipalId: userContext.principalId,
        sessionId: workflowId,
        kind: 'ab-comparison-branch',
        title: `Branch ${branch.id.slice(0, 6)} — ${branch.option.providerName}`,
        content: branchContent,
        status: 'draft',
        version: 1,
      })
      .returning();
    if (inserted) artifactIds.push(inserted.id);
  }

  // Mark workflow done.
  await db.update(workflowRun).set({ status: 'done' }).where(eq(workflowRun.id, workflowId));

  return { artifactIds };
}
