import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { ArtifactSource, SessionStatus } from "@workbench/shared";
import type { HubDb } from "../db";
import { workflowRun, workflowRunRecord } from "../db/schema";

type WorkflowRunRecordStatus =
  (typeof workflowRunRecord.$inferSelect)["status"];
import { loadWorkflowKindLabels } from "./workflow-kind-labels";
import type { WorkflowMeta } from "./workflow-meta";

/** Provenance session key stored on artifact `source` by workflow/agent writers. */
export function sessionProvenanceKey(source: ArtifactSource): string | null {
  const raw = (source as Record<string, unknown>).sessionId;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export function workflowRunStatusToSessionStatus(
  status: WorkflowRunRecordStatus,
): SessionStatus {
  switch (status) {
    case "provisioning":
      return "pending";
    case "running":
      return "generating";
    case "awaiting":
      return "reviewing";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    // A user-stopped run is terminal and did not finish. `SessionStatus` is a
    // closed union with no cancelled member, and the artifact viewers only ask
    // whether the producing session is still working — so `failed` is the one
    // mapping that is both terminal and honest. `done` would assert a
    // completion that never happened and hide a partial artifact body.
    case "stopped":
      return "failed";
  }
}

function labelFromWorkflowRunMeta(
  meta: WorkflowMeta | null | undefined,
  kind: string,
  kindLabels: Map<string, string>,
): string {
  const fromMeta = meta?.label?.trim();
  if (fromMeta !== undefined && fromMeta !== "") return fromMeta;
  const fromJob = kindLabels.get(kind);
  if (fromJob !== undefined) return fromJob;
  return kind;
}

type EnrichableRow = {
  source: ArtifactSource;
  sessionId: string | null;
  sessionName: string | null;
  sessionStatus: SessionStatus | null;
};

/**
 * Fills `sessionId`, `sessionName`, and `sessionStatus` on artifact API rows by
 * joining provenance `source.sessionId` against `workflow_run_record` (run id or
 * deployment id) and `workflow_run` deploy meta for display labels.
 */
export async function attachArtifactSessionEnrichment(
  db: HubDb,
  tenantId: string,
  rows: EnrichableRow[],
): Promise<void> {
  const keys = [
    ...new Set(
      rows
        .map((row) => sessionProvenanceKey(row.source))
        .filter((k): k is string => k !== null),
    ),
  ];
  if (keys.length === 0) return;

  const kindLabels = await loadWorkflowKindLabels();

  const runRows = await db
    .select({
      id: workflowRunRecord.id,
      deploymentId: workflowRunRecord.deploymentId,
      kind: workflowRunRecord.kind,
      status: workflowRunRecord.status,
      createdAt: workflowRunRecord.createdAt,
    })
    .from(workflowRunRecord)
    .where(
      and(
        eq(workflowRunRecord.tenantId, tenantId),
        isNull(workflowRunRecord.deletedAt),
        or(
          inArray(workflowRunRecord.id, keys),
          inArray(workflowRunRecord.deploymentId, keys),
        ),
      ),
    )
    .orderBy(desc(workflowRunRecord.createdAt));

  const byRunId = new Map<string, (typeof runRows)[number]>();
  const byDeploymentId = new Map<string, (typeof runRows)[number]>();
  for (const row of runRows) {
    if (!byRunId.has(row.id)) byRunId.set(row.id, row);
    if (row.deploymentId !== null && !byDeploymentId.has(row.deploymentId)) {
      byDeploymentId.set(row.deploymentId, row);
    }
  }

  const deploymentIds = [
    ...new Set(
      runRows
        .map((r) => r.deploymentId)
        .filter((id): id is string => id !== null),
    ),
  ];

  const metaByDeployment = new Map<string, WorkflowMeta | null>();
  if (deploymentIds.length > 0) {
    const indexRows = await db
      .select({
        deploymentId: workflowRun.deploymentId,
        kind: workflowRun.kind,
        meta: workflowRun.meta,
      })
      .from(workflowRun)
      .where(
        and(
          eq(workflowRun.tenantId, tenantId),
          inArray(workflowRun.deploymentId, deploymentIds),
          isNull(workflowRun.deletedAt),
        ),
      )
      .orderBy(desc(workflowRun.updatedAt));
    for (const row of indexRows) {
      if (row.deploymentId === null) continue;
      if (metaByDeployment.has(row.deploymentId)) continue;
      metaByDeployment.set(row.deploymentId, row.meta ?? null);
    }
  }

  for (const row of rows) {
    const key = sessionProvenanceKey(row.source);
    if (key === null) continue;

    const run = byRunId.get(key) ?? byDeploymentId.get(key) ?? null;
    if (run === null) continue;

    row.sessionId = run.id;
    row.sessionStatus = workflowRunStatusToSessionStatus(run.status);
    const meta =
      run.deploymentId !== null
        ? metaByDeployment.get(run.deploymentId)
        : undefined;
    row.sessionName = labelFromWorkflowRunMeta(
      meta ?? null,
      run.kind,
      kindLabels,
    );
  }
}
