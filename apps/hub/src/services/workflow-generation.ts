import { and, eq, inArray } from 'drizzle-orm';
import { getLogger } from '@intx/log';
import type { InferenceSource } from '@intx/types/runtime';
import { workflowRegistry } from '@workbench/workflow-core';
import type { UserContext } from '@workbench/workflow-core';
import { getVariantCount, resolveArtifactKind } from '@workbench/gtm-workflows';
import type { HubDb } from '../db';
import { workflowRun, transcript, painPoint, artifact, artifactVersion } from '../db/schema';
import { extractPainPoints } from '../lib/extraction';
import { generateCollateralWithLLM } from '../lib/generation';
import {
  serializePainPoint,
  serializeArtifact,
  type PainPointRow,
  type ArtifactRow,
} from '../serializers/workflow';
import { mapDbStatusToSessionStatus } from './workflow-status';

const log = getLogger(['api', 'workflow']);

interface WorkflowInput {
  transcriptId?: string;
  companyName?: string;
}

export async function runAnalyze(
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

  if (!wf) {
    log.warn('Workflow not found for analyze', { workflowId: id });
    return Response.json({ error: 'Workflow not found' }, { status: 404 });
  }

  await db.update(workflowRun).set({ status: 'analyzing' }).where(eq(workflowRun.id, id));

  let inserted: PainPointRow[];

  try {
    const transcriptId = (wf.input as WorkflowInput)?.transcriptId;
    const tx = transcriptId
      ? await db.query.transcript.findFirst({ where: eq(transcript.id, transcriptId) })
      : null;

    if (!tx) {
      log.error('Transcript not found for analyze', { workflowId: id, transcriptId });
      throw new Error('Transcript not found');
    }

    log.info('Extracting pain points', { workflowId: id, transcriptLength: tx.content.length });
    const { painPoints: extracted, companyName } = await extractPainPoints(
      id,
      tx.content,
      feedback,
      source,
      maxOutputTokens
    );
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

    // Always replace: analyze owns the run's pain points, so a re-entrant
    // auto-analyze must not double-insert. The skip-analysis seeding path never
    // calls runAnalyze, so its pre-selected points are never reached here.
    await db.delete(painPoint).where(eq(painPoint.sessionId, id));

    inserted = extracted.length > 0 ? await db.insert(painPoint).values(extracted).returning() : [];

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
  } catch (error) {
    log.error('Analyze step failed', { workflowId: id, error: String(error) });
    await db.update(workflowRun).set({ status: 'failed' }).where(eq(workflowRun.id, id));
    return Response.json({ error: 'Analysis failed' }, { status: 500 });
  }

  log.info('Analyze step complete', { workflowId: id, insertedCount: inserted.length });

  return Response.json({
    id,
    status: mapDbStatusToSessionStatus('running'),
    currentStep: 'generate',
    steps: {
      analyze: { completed: true, painPoints: inserted.map(serializePainPoint) },
    },
  });
}

export async function runGenerate(
  db: HubDb,
  id: string,
  painPointIds: string[],
  collateralTypes: string[],
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

  await db.update(workflowRun).set({ status: 'generating' }).where(eq(workflowRun.id, id));

  let nextStatus: string;
  let inserted: ArtifactRow[];

  try {
    const transcriptId = (wf.input as WorkflowInput)?.transcriptId;
    const tx = transcriptId
      ? await db.query.transcript.findFirst({ where: eq(transcript.id, transcriptId) })
      : null;
    const transcriptContent: string = tx?.content ?? '';

    // Reset stale selections from prior runs, then persist exactly this run's
    // selection — the UI's generating summary reads this flag after a remount.
    await db.update(painPoint).set({ selected: false }).where(eq(painPoint.sessionId, id));
    await db
      .update(painPoint)
      .set({ selected: true })
      .where(and(inArray(painPoint.id, painPointIds), eq(painPoint.sessionId, id)));

    const workflowDefinition = workflowRegistry.get(wf.kind);
    const artifactKinds = workflowDefinition?.selectGenerateArtifactKinds?.(collateralTypes) ?? [];
    if (artifactKinds.length === 0) {
      log.warn('No valid collateral types for generate', { workflowId: id, collateralTypes });
      // Restore the post-analyze selection state ('running' → session 'ready'),
      // not the session status 'ready', which is not a valid DB status and
      // would poison every later GET via mapDbStatusToSessionStatus.
      await db.update(workflowRun).set({ status: 'running' }).where(eq(workflowRun.id, id));
      return Response.json({ error: 'No valid collateral types selected.' }, { status: 400 });
    }

    const results = await Promise.allSettled(
      points.flatMap((p: PainPointRow) =>
        artifactKinds.flatMap((kind) => {
          const variantCount = getVariantCount(kind);
          return Array.from({ length: variantCount }, (_, variantIndex) =>
            generateCollateralWithLLM(
              id,
              transcriptContent,
              p,
              kind,
              source,
              maxOutputTokens,
              variantIndex
            ).then(({ title, body }) => ({
              tenantId: wf.tenantId,
              principalId: wf.principalId,
              sessionId: id,
              painPointId: p.id,
              kind: resolveArtifactKind(kind),
              title,
              content: body,
              status: 'draft' as const,
              version: 1,
            }))
          );
        })
      )
    );

    const generated = results.flatMap(
      (
        r: PromiseSettledResult<{
          tenantId: string;
          principalId: string;
          sessionId: string;
          painPointId: string;
          kind: string;
          title: string;
          content: string;
          status: 'draft';
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

    inserted =
      generated.length > 0
        ? await db.transaction(async (trx) => {
            const rows = (await trx
              .insert(artifact)
              .values(generated)
              .returning()) as ArtifactRow[];
            await trx.insert(artifactVersion).values(
              rows.map((a) => ({
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

    const rejectedCount = results.filter((r) => r.status === 'rejected').length;
    if (generated.length === 0 && rejectedCount > 0) {
      log.error('All artifact generations failed', { workflowId: id, failedCount: rejectedCount });
      nextStatus = 'failed';
    } else {
      nextStatus = inserted.length > 0 ? 'reviewing' : 'done';
    }
  } catch (error) {
    log.error('Generate step failed', { workflowId: id, error: String(error) });
    await db.update(workflowRun).set({ status: 'failed' }).where(eq(workflowRun.id, id));
    return Response.json({ error: 'Generation failed' }, { status: 500 });
  }

  await db.update(workflowRun).set({ status: nextStatus }).where(eq(workflowRun.id, id));

  log.info('Generate step complete', {
    workflowId: id,
    artifactCount: inserted.length,
    status: nextStatus,
  });

  return Response.json({
    id,
    status: mapDbStatusToSessionStatus(nextStatus),
    currentStep: 'generate',
    steps: {
      generate: { completed: true, artifacts: inserted.map(serializeArtifact) },
    },
  });
}
