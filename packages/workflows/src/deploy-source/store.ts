// Persistence for `workflow_deploy_source`, kept apart from the
// deploy-call decorator that drives it so the write shape is
// unit-testable without a real `SessionService`. `WorkflowDeploySourceStore`
// is the seam; `createDrizzleWorkflowDeploySourceStore` is its production
// implementation over `./schema.ts`.
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { WorkflowDefinitionSource } from "@intx/types/workflow-sources";

import { workflowDeploySource, type WorkflowDeploySourceRow } from "./schema";

/**
 * The drizzle handle `createDrizzleWorkflowDeploySourceStore` operates
 * against. Generic over the host's schema record, like
 * `@corbits/run-key-history`'s own `RunKeyHistoryDb` — the host hands in
 * its own `drizzle(sql, { schema })` instance unchanged, and no cast is
 * needed at the call site.
 */
export type WorkflowDeploySourceDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

export type WorkflowDeploySourceRecord = {
  anchorRunId: string;
  tenantId: string;
  deploymentDomain: string;
  source: WorkflowDefinitionSource;
  entry: string;
  pin?: string;
  definitionAssetId: string;
  sourceRef?: string;
  sourceAuthorityPrincipalId: string;
};

export interface WorkflowDeploySourceStore {
  /**
   * Record (or overwrite, on a redeploy/rotation) the deploy source for one
   * anchor run. Idempotent: recording the same anchor run twice replaces the
   * row in place rather than accumulating history — the durable answer to
   * "what is this deployment's source right now", not an audit log.
   */
  record(entry: WorkflowDeploySourceRecord): Promise<void>;
  /** The current source record for an anchor run, or `null` if none was
   * ever recorded (e.g. a deployment that predates this store). */
  get(anchorRunId: string): Promise<WorkflowDeploySourceRow | null>;
}

export function createDrizzleWorkflowDeploySourceStore<
  TSchema extends Record<string, unknown>,
>(db: WorkflowDeploySourceDb<TSchema>): WorkflowDeploySourceStore {
  return {
    async record(entry) {
      await db
        .insert(workflowDeploySource)
        .values({
          anchorRunId: entry.anchorRunId,
          tenantId: entry.tenantId,
          deploymentDomain: entry.deploymentDomain,
          source: entry.source,
          entry: entry.entry,
          pin: entry.pin ?? null,
          definitionAssetId: entry.definitionAssetId,
          sourceRef: entry.sourceRef ?? null,
          sourceAuthorityPrincipalId: entry.sourceAuthorityPrincipalId,
          recordedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: workflowDeploySource.anchorRunId,
          set: {
            tenantId: entry.tenantId,
            deploymentDomain: entry.deploymentDomain,
            source: entry.source,
            entry: entry.entry,
            pin: entry.pin ?? null,
            definitionAssetId: entry.definitionAssetId,
            sourceRef: entry.sourceRef ?? null,
            sourceAuthorityPrincipalId: entry.sourceAuthorityPrincipalId,
            recordedAt: new Date(),
          },
        });
    },

    async get(anchorRunId) {
      const [row] = await db
        .select()
        .from(workflowDeploySource)
        .where(eq(workflowDeploySource.anchorRunId, anchorRunId))
        .limit(1);
      return row ?? null;
    },
  };
}
