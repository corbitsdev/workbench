import { and, eq, inArray } from 'drizzle-orm';
import { getLogger } from '@intx/log';
import { resolveCredentialRequirement } from '@intx/db';
import type { InferenceSource } from '@intx/types/runtime';
import { workflowRegistry } from '@workbench/workflow-core';
import type { UserContext } from '@workbench/workflow-core';
import { getVariantCount, resolveArtifactKind } from '@workbench/gtm-workflows';
import { generateFromTemplate } from '@workbench/tools-gamma';
import type { HubDb } from '../db';
import { workflowRun, transcript, painPoint, artifact, artifactVersion } from '../db/schema';
import { runSingleTurnAgent } from '../lib/inference';
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

const PRESENTATION_GENERATE_SYSTEM_PROMPT = `You write slide content for branded presentations. Given a call brief and transcript, generate slide-by-slide content for a Gamma presentation.

Guidelines:
- Voice is direct and confident — no corporate superlatives, no padding
- No em dashes, no hashtags, no bullet threads
- Never position Corbits as the hero — the customer and their problem are central
- Lead with the tension or question the audience already has
- Each slide earns its place — no filler

Format each slide as:
SLIDE N: [Title]
[Content — 2-5 sentences or a clean list, no padding]

Generate the number of slides appropriate for the template and brief.`;

const PRESENTATION_REVIEW_SYSTEM_PROMPT = `You are a brand editor reviewing a presentation draft. Edit and tighten the content. Return the improved version in the same SLIDE N: format.

Remove:
- Em dashes (rewrite the sentence instead)
- Hashtags
- Corporate superlatives ("best in class", "revolutionary", "cutting-edge")
- Opener padding ("We're excited to announce", "Today we're thrilled to share")
- Filler slides that add no substance

Fix:
- Voice must be direct and confident, never corporate
- Naming must be consistent (use "workbench", not "workspace")
- Tone must match the brief

Storytelling:
- Customer and their problem are the hero — not Corbits
- Open with a question or tension, not a claim
- Every slide must earn its place`;

function buildPresentationUserMessage(briefContext: string, sourceContent: string): string {
  const parts = [briefContext];
  if (sourceContent.trim()) parts.push(`Source content:\n${sourceContent}`);
  return parts.join('\n\n');
}

export async function runPresentationGenerate(
  db: HubDb,
  workflowId: string,
  tenantId: string,
  source: InferenceSource
): Promise<void> {
  const wf = await db.query.workflowRun.findFirst({ where: eq(workflowRun.id, workflowId) });
  if (!wf) {
    log.warn('Workflow not found for presentation generate', { workflowId });
    return;
  }

  const wfInput = (wf.input as Record<string, unknown>) ?? {};

  let sourceContent = '';
  if (typeof wfInput.transcriptId === 'string') {
    const txRow = await db.query.transcript.findFirst({
      where: eq(transcript.id, wfInput.transcriptId),
    });
    sourceContent = txRow?.content ?? '';
  } else if (typeof wfInput.sourceArtifactId === 'string') {
    const sourceArtifact = await db.query.artifact.findFirst({
      where: eq(artifact.id, wfInput.sourceArtifactId),
    });
    sourceContent = sourceArtifact?.content ?? '';
  }

  const briefParts: string[] = [];
  if (typeof wfInput.templateId === 'string') briefParts.push(`Template: ${wfInput.templateId}`);
  if (typeof wfInput.audience === 'string') briefParts.push(`Audience: ${wfInput.audience}`);
  if (typeof wfInput.tone === 'string') briefParts.push(`Tone: ${wfInput.tone}`);
  if (typeof wfInput.goal === 'string') briefParts.push(`Goal: ${wfInput.goal}`);
  if (typeof wfInput.callTitle === 'string') briefParts.push(`Source call: ${wfInput.callTitle}`);
  const briefContext = briefParts.join('\n');

  try {
    await db
      .update(workflowRun)
      .set({ status: 'generating' })
      .where(eq(workflowRun.id, workflowId));
    log.info('Presentation pipeline: round 1 generating content', { workflowId });
    const generatedContent = await runSingleTurnAgent(
      source,
      PRESENTATION_GENERATE_SYSTEM_PROMPT,
      buildPresentationUserMessage(briefContext, sourceContent),
      'presentation-generate'
    );

    await db.update(workflowRun).set({ status: 'reviewing' }).where(eq(workflowRun.id, workflowId));
    log.info('Presentation pipeline: round 2 reviewing content', { workflowId });
    const reviewedContent = await runSingleTurnAgent(
      source,
      PRESENTATION_REVIEW_SYSTEM_PROMPT,
      generatedContent,
      'presentation-review'
    );

    await db.update(workflowRun).set({ status: 'rendering' }).where(eq(workflowRun.id, workflowId));
    log.info('Presentation pipeline: round 3 rendering in Gamma', { workflowId });

    let gammaResolved;
    try {
      gammaResolved = await resolveCredentialRequirement(
        db,
        tenantId,
        { providerName: 'gamma', source: 'tenant' as const },
        null,
        null
      );
    } catch {
      gammaResolved = null;
    }
    if (!gammaResolved) throw new Error('No Gamma credential configured for this tenant');

    const templateId = typeof wfInput.templateId === 'string' ? wfInput.templateId : '';
    if (!templateId) throw new Error('No templateId in workflow input');
    const callTitle = typeof wfInput.callTitle === 'string' ? wfInput.callTitle : 'Presentation';

    const controller = new AbortController();
    const { gammaUrl, gammaId } = await generateFromTemplate(
      { apiKey: gammaResolved.secret },
      { gammaId: templateId, prompt: reviewedContent, title: callTitle },
      controller.signal
    );

    await db.insert(artifact).values({
      tenantId: wf.tenantId,
      principalId: wf.principalId,
      sessionId: workflowId,
      kind: 'presentation',
      title: callTitle,
      content: reviewedContent,
      status: 'draft',
      version: 1,
    });

    await db
      .update(workflowRun)
      .set({ status: 'done', input: { ...wfInput, gammaUrl, gammaId } })
      .where(eq(workflowRun.id, workflowId));

    log.info('Presentation pipeline: complete', { workflowId, gammaUrl });
  } catch (error) {
    log.error('Presentation pipeline failed', { workflowId, error: String(error) });
    await db.update(workflowRun).set({ status: 'failed' }).where(eq(workflowRun.id, workflowId));
  }
}
