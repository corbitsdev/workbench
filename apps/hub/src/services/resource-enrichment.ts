import { and, eq } from 'drizzle-orm';
import { type } from 'arktype';
import { getLogger } from '@intx/log';
import {
  assembleSeoCsv,
  buildErrorSelectionDraft,
  CSV_EXPORT_ARTIFACT_KIND,
  enrichSeoRow,
  PARSED_RESOURCE_ARTIFACT_KIND,
  parseSelectionArtifactContent,
  parseSeoResourceWorkbook,
  SeoResourceRow,
  SELECTION_ARTIFACT_KIND,
} from '@workbench/gtm-workflows';
import type { UserContext } from '@workbench/workflow-core';
import type { ImageBlock, InferenceSource } from '@intx/types/runtime';
import type { HubDb } from '../db';
import { runSingleTurnAgentWithImage } from '../lib/inference';
import { artifact, artifactVersion, upload, workflowRun } from '../db/schema';

const log = getLogger(['service', 'resource-enrichment']);

// Kinds whose runs are driven by this service (intake → enrich → review →
// export) rather than the collateral pain-point pipeline. seo-enrichment is the
// only one today; both compose the resource-enrichment base.
const RESOURCE_ENRICHMENT_KINDS = new Set(['seo-enrichment']);

export function isResourceEnrichmentKind(kind: string): boolean {
  return RESOURCE_ENRICHMENT_KINDS.has(kind);
}

// Cap rows per run so a single 10MB upload cannot trigger unbounded inference
// spend. Until chunked processing is proven at scale, larger catalogs are
// rejected with a clear message rather than silently truncated.
const MAX_ENRICH_ROWS = 500;

// Per-batch fan-out width. Bounds concurrent provider load (and in-flight
// promises against the per-call timeout) instead of firing one request per row.
const ENRICH_CONCURRENCY = 8;

async function insertArtifactWithVersion(
  db: HubDb,
  values: {
    tenantId: string;
    principalId: string;
    ownerPrincipalId: string;
    sessionId: string;
    kind: string;
    title: string;
    content: string;
    status: 'draft' | 'approved';
  }
): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(artifact)
      .values({ ...values, version: 1 })
      .returning({ id: artifact.id });
    if (!row) throw new Error('Failed to insert artifact');
    await tx.insert(artifactVersion).values({
      artifactId: row.id,
      version: 1,
      title: values.title,
      content: values.content,
      authorId: values.principalId,
    });
    return row;
  });
}

// Create the run and run intake: parse the upload into rows and persist a
// parsed-resource snapshot. Lands the run in 'running', ready for the enrich
// step (which needs a resolved inference source and so runs separately).
export async function createResourceEnrichmentRun(
  db: HubDb,
  userContext: UserContext,
  kind: string,
  uploadId: string
): Promise<{ id: string; status: string; kind: string }> {
  const uploadRow = await db.query.upload.findFirst({ where: eq(upload.id, uploadId) });
  if (!uploadRow) {
    throw new ResourceEnrichmentError('Upload not found', 404);
  }
  if (uploadRow.tenantId !== userContext.tenantId) {
    throw new ResourceEnrichmentError('Upload not found', 404);
  }

  const { rows, rejected } = await parseSeoResourceWorkbook(Buffer.from(uploadRow.content));
  if (rows.length === 0) {
    throw new ResourceEnrichmentError('No valid rows found in the uploaded file', 400);
  }
  if (rows.length > MAX_ENRICH_ROWS) {
    throw new ResourceEnrichmentError(
      `File has ${rows.length} rows; the maximum is ${MAX_ENRICH_ROWS}`,
      400
    );
  }

  const [wfRow] = await db
    .insert(workflowRun)
    .values({
      tenantId: userContext.tenantId,
      principalId: userContext.principalId,
      kind,
      status: 'pending',
      input: { uploadId, filename: uploadRow.filename },
    })
    .returning();
  if (!wfRow) throw new ResourceEnrichmentError('Failed to create workflow', 500);

  await insertArtifactWithVersion(db, {
    tenantId: userContext.tenantId,
    principalId: userContext.principalId,
    ownerPrincipalId: userContext.principalId,
    sessionId: wfRow.id,
    kind: PARSED_RESOURCE_ARTIFACT_KIND,
    title: uploadRow.filename,
    content: JSON.stringify({ rows, rejected }),
    status: 'approved',
  });

  await db.update(workflowRun).set({ status: 'running' }).where(eq(workflowRun.id, wfRow.id));
  log.info('Resource enrichment run created and parsed', {
    workflowId: wfRow.id,
    kind,
    rows: rows.length,
  });

  return { id: wfRow.id, status: 'running', kind };
}

function readParsedRows(content: string): SeoResourceRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ResourceEnrichmentError('Parsed-resource artifact is not valid JSON', 500);
  }
  const rowsValue = (parsed as { rows?: unknown }).rows;
  if (!Array.isArray(rowsValue)) {
    throw new ResourceEnrichmentError('Parsed-resource artifact has no rows', 500);
  }
  // Validate rather than cast — the content was written by an earlier step and
  // could be stale/corrupt; feeding garbage into enrichSeoRow yields opaque
  // failures. Invalid rows are dropped (already flagged at intake).
  const rows: SeoResourceRow[] = [];
  for (const candidate of rowsValue) {
    const result = SeoResourceRow(candidate);
    if (result instanceof type.errors) continue;
    rows.push(result);
  }
  if (rows.length === 0) {
    throw new ResourceEnrichmentError('Parsed-resource artifact has no valid rows', 500);
  }
  return rows;
}

// Run the enrich step: fan out one inference call per parsed row, isolating
// per-row failures, then persist one selection artifact each and land the run in
// 'reviewing'. The per-row SEO logic lives in the package (enrichSeoRow); the
// hub only injects the credential-backed inference call and persists results.
export async function runResourceEnrichmentEnrich(
  db: HubDb,
  workflowId: string,
  userContext: UserContext,
  source: InferenceSource,
  maxOutputTokens?: number
): Promise<{ status: string; selections: number }> {
  const parsedArtifact = await db.query.artifact.findFirst({
    where: and(
      eq(artifact.sessionId, workflowId),
      eq(artifact.kind, PARSED_RESOURCE_ARTIFACT_KIND)
    ),
  });
  if (!parsedArtifact) {
    throw new ResourceEnrichmentError('No parsed-resource artifact for this run', 400);
  }

  const infer = (args: { systemPrompt: string; userMessage: string; image: ImageBlock }) =>
    runSingleTurnAgentWithImage(
      source,
      args.systemPrompt,
      args.userMessage,
      args.image,
      maxOutputTokens
    );

  const rows = readParsedRows(parsedArtifact.content);

  // Fan out in bounded batches: one concurrent inference call per row would fire
  // hundreds at once on a large catalog and exhaust provider limits / wedge the
  // step against the per-call timeout (CL-1922 class).
  let selections = 0;
  for (let start = 0; start < rows.length; start += ENRICH_CONCURRENCY) {
    const batch = rows.slice(start, start + ENRICH_CONCURRENCY);
    const settled = await Promise.allSettled(batch.map((row) => enrichSeoRow(row, infer)));
    for (let j = 0; j < settled.length; j++) {
      const outcome = settled[j];
      const draft =
        outcome?.status === 'fulfilled'
          ? outcome.value
          : buildErrorSelectionDraft(
              batch[j] ?? { productSlug: `row-${start + j}` },
              'enrichment failed'
            );
      await insertArtifactWithVersion(db, {
        tenantId: userContext.tenantId,
        principalId: userContext.principalId,
        ownerPrincipalId: userContext.principalId,
        sessionId: workflowId,
        kind: draft.kind,
        title: draft.title,
        content: draft.content,
        status: 'draft',
      });
      selections += 1;
    }
  }

  await db.update(workflowRun).set({ status: 'reviewing' }).where(eq(workflowRun.id, workflowId));
  log.info('Resource enrichment enrich complete', { workflowId, selections });

  return { status: 'reviewing', selections };
}

// Assemble a csv-export artifact from every selection the reviewer has decided
// (chosen !== null) and mark the run done. Selections still awaiting a pick are
// excluded rather than blocking the export. image_link is joined from the parsed
// rows by product slug. `timestamp` is injected so the output is deterministic
// under test.
export async function runResourceEnrichmentExport(
  db: HubDb,
  workflowId: string,
  userContext: UserContext,
  timestamp: string = new Date().toISOString()
): Promise<{ id: string; status: string }> {
  const selections = await db.query.artifact.findMany({
    where: and(eq(artifact.sessionId, workflowId), eq(artifact.kind, SELECTION_ARTIFACT_KIND)),
  });

  const chosen = selections
    .map((row) => parseSelectionArtifactContent(row.content))
    .filter((content) => content.chosen !== null);

  if (chosen.length === 0) {
    throw new ResourceEnrichmentError('No selections have been chosen yet', 400);
  }

  const parsedArtifact = await db.query.artifact.findFirst({
    where: and(
      eq(artifact.sessionId, workflowId),
      eq(artifact.kind, PARSED_RESOURCE_ARTIFACT_KIND)
    ),
  });
  const rows = parsedArtifact ? readParsedRows(parsedArtifact.content) : [];

  const csv = assembleSeoCsv(rows, chosen, timestamp);
  const created = await insertArtifactWithVersion(db, {
    tenantId: userContext.tenantId,
    principalId: userContext.principalId,
    ownerPrincipalId: userContext.principalId,
    sessionId: workflowId,
    kind: CSV_EXPORT_ARTIFACT_KIND,
    title: 'Enriched resources',
    content: csv,
    status: 'approved',
  });

  await db.update(workflowRun).set({ status: 'done' }).where(eq(workflowRun.id, workflowId));
  log.info('Resource enrichment export complete', { workflowId, artifactId: created.id });

  return { id: created.id, status: 'done' };
}

export type ResourceEnrichmentErrorStatus = 400 | 404 | 500;

export class ResourceEnrichmentError extends Error {
  constructor(
    message: string,
    public readonly status: ResourceEnrichmentErrorStatus
  ) {
    super(message);
    this.name = 'ResourceEnrichmentError';
  }
}
