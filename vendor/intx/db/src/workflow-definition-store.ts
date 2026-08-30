import { and, desc, eq } from "drizzle-orm";

import { GrantWalkSnapshot, type WorkflowDefinitionStatus } from "@intx/types";
import { WorkflowProjectionDefinition } from "@intx/types/sidecar";

import type { DB, DBExecutor } from "./client";
import {
  workflowDefinition,
  workflowDefinitionVersion,
} from "./schema/workflow-definitions";
import { parseWorkflowDefinitionRow } from "./parse-row";

type DBHandle = DB["db"];
type ParsedWorkflowDefinition = ReturnType<typeof parseWorkflowDefinitionRow>;

// The version `ensureWorkflowDefinitionForAsset` projects for a fresh
// definition, and therefore the row the approval freeze stamps the grant
// snapshot onto. Hand-coupled to the ensure helper's initial version; if that
// helper ever projects a different version this must follow.
const FROZEN_VERSION = "1";

/**
 * The selector that keys a workflow definition's identity: the asset it
 * projects and the content hash of its wire projection. A single asset backs
 * many definitions distinguished by their wire hash, so both fields are
 * required to name exactly one definition.
 */
export type WorkflowDefinitionSelector = {
  assetId: string;
  wireHash: string;
};

/**
 * The definition a selector names, or null when no definition has been folded
 * for that `(assetId, wireHash)` pair. This is the single expression of the
 * deployment -> definition mapping (a deployment names its asset and wire hash);
 * the run backfill and the native-run insert sites both resolve through it.
 * Null on a miss is deliberate, not an error: a deployment whose selector the
 * run-once fold never covered has no definition yet, and its runs anchor on
 * `runId` until that gap closes.
 */
export async function resolveDefinitionIdForAsset(
  db: DBExecutor,
  selector: WorkflowDefinitionSelector,
): Promise<string | null> {
  const row = await db
    .select({ id: workflowDefinition.id })
    .from(workflowDefinition)
    .where(
      and(
        eq(workflowDefinition.assetId, selector.assetId),
        eq(workflowDefinition.wireHash, selector.wireHash),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);
  return row?.id ?? null;
}

/**
 * Read the deploy-approved grant-walk snapshot frozen onto a definition's
 * version row, validated as a `GrantWalkSnapshot` at this boundary. Returns
 * `null` when the version row is absent or its `grantSnapshot` column is still
 * `null` -- the "not yet approved" state, mirroring `approvedWireHash`. The
 * caller fails closed on `null`; it never substitutes an empty grant set.
 */
export async function loadFrozenGrantSnapshot(
  db: DBExecutor,
  definitionId: string,
): Promise<GrantWalkSnapshot | null> {
  const row = await db
    .select({ grantSnapshot: workflowDefinitionVersion.grantSnapshot })
    .from(workflowDefinitionVersion)
    .where(
      and(
        eq(workflowDefinitionVersion.definitionId, definitionId),
        eq(workflowDefinitionVersion.version, FROZEN_VERSION),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);
  if (row === undefined || row.grantSnapshot === null) return null;
  return GrantWalkSnapshot.assert(row.grantSnapshot);
}

/**
 * WORKBENCH DELTA (see VENDORED.md): read the inert wire projection frozen onto
 * a definition's version row, validated at this boundary. Mirrors
 * `loadFrozenGrantSnapshot` exactly — same version row, same null-means-not-yet-
 * approved contract — because it is written by the same freeze transaction.
 * Returns `null` when the version row is absent or its `wireProjection` column
 * is still `null`; the caller fails closed with a named error, never a fallback
 * read of a retired `workflow.json` envelope.
 */
export async function loadFrozenWireProjection(
  db: DBExecutor,
  definitionId: string,
): Promise<WorkflowProjectionDefinition | null> {
  const row = await db
    .select({ wireProjection: workflowDefinitionVersion.wireProjection })
    .from(workflowDefinitionVersion)
    .where(
      and(
        eq(workflowDefinitionVersion.definitionId, definitionId),
        eq(workflowDefinitionVersion.version, FROZEN_VERSION),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);
  if (row === undefined || row.wireProjection === null) return null;
  return WorkflowProjectionDefinition.assert(row.wireProjection);
}

export type WorkflowDefinitionRollbackResult =
  | { ok: true; definition: ParsedWorkflowDefinition }
  | { ok: false; reason: "definition_not_found" | "version_not_found" };

/**
 * Store for the first-class `workflow_definition` and its version history.
 */
export function createWorkflowDefinitionStore(db: DBHandle) {
  return {
    // WORKBENCH DELTA (see VENDORED.md): the four read shapes CL-7275 found
    // 41 hand-rolled call sites reaching for because the shipped store only
    // covered the `(assetId, wireHash)` selector and the frozen-version
    // reads. Every one of those 41 sites is one of: a single definition by
    // its id, a single definition by its name, every deployed definition for
    // a tenant, or every definition sharing an asset -- always tenant-scoped,
    // since a definition is never read across tenants. Centralizing them
    // here means an invariant Interchange adds later (a status filter, a
    // required join) reaches every caller instead of only the two that
    // already routed through `loadFrozenWireProjection`.

    /**
     * A single definition by id, scoped to the tenant that must own it.
     * `undefined` on a miss -- including a real id from another tenant,
     * which callers must see as "not found", never a cross-tenant read.
     */
    async findById(
      tenantId: string,
      definitionId: string,
    ): Promise<ParsedWorkflowDefinition | undefined> {
      const row = await db.query.workflowDefinition.findFirst({
        where: and(
          eq(workflowDefinition.id, definitionId),
          eq(workflowDefinition.tenantId, tenantId),
        ),
      });
      return row === undefined ? undefined : parseWorkflowDefinitionRow(row);
    },

    /**
     * A single definition by its (tenant-scoped) name. Callers that only
     * ever want the launchable one pass `status: "deployed"`; callers
     * resolving an id for a name regardless of lifecycle state omit it.
     */
    async findByName(
      tenantId: string,
      name: string,
      opts: { status?: WorkflowDefinitionStatus } = {},
    ): Promise<ParsedWorkflowDefinition | undefined> {
      const row = await db.query.workflowDefinition.findFirst({
        where: and(
          eq(workflowDefinition.tenantId, tenantId),
          eq(workflowDefinition.name, name),
          ...(opts.status !== undefined
            ? [eq(workflowDefinition.status, opts.status)]
            : []),
        ),
      });
      return row === undefined ? undefined : parseWorkflowDefinitionRow(row);
    },

    /**
     * Every definition in a tenant, optionally narrowed by status. The
     * listing surface behind "what can this tenant launch" -- callers that
     * pass `status: "deployed"` are asking exactly that.
     */
    async listByTenant(
      tenantId: string,
      opts: { status?: WorkflowDefinitionStatus } = {},
    ): Promise<ParsedWorkflowDefinition[]> {
      const rows = await db.query.workflowDefinition.findMany({
        where: and(
          eq(workflowDefinition.tenantId, tenantId),
          ...(opts.status !== undefined
            ? [eq(workflowDefinition.status, opts.status)]
            : []),
        ),
      });
      return rows.map(parseWorkflowDefinitionRow);
    },

    /**
     * Every definition sharing an asset, newest first -- the sibling
     * versions a single asset backs (see `WorkflowDefinitionSelector`).
     * Ordering matches the one hand-rolled call site this replaces, which
     * relied on `createdAt desc` to name the newest sibling first.
     */
    async listByAsset(
      tenantId: string,
      assetId: string,
      opts: { status?: WorkflowDefinitionStatus } = {},
    ): Promise<ParsedWorkflowDefinition[]> {
      const rows = await db.query.workflowDefinition.findMany({
        where: and(
          eq(workflowDefinition.tenantId, tenantId),
          eq(workflowDefinition.assetId, assetId),
          ...(opts.status !== undefined
            ? [eq(workflowDefinition.status, opts.status)]
            : []),
        ),
        orderBy: desc(workflowDefinition.createdAt),
      });
      return rows.map(parseWorkflowDefinitionRow);
    },

    /**
     * Patch a definition's mutable fields (description, lifecycle status),
     * tenant-scoped so a stale id from another tenant updates nothing.
     * `updatedAt` is always stamped; callers never pass it themselves.
     */
    async updateFields(
      tenantId: string,
      definitionId: string,
      patch: { description?: string; status?: WorkflowDefinitionStatus },
    ): Promise<void> {
      await db
        .update(workflowDefinition)
        .set({ ...patch, updatedAt: new Date() })
        .where(
          and(
            eq(workflowDefinition.id, definitionId),
            eq(workflowDefinition.tenantId, tenantId),
          ),
        );
    },

    /**
     * Roll a definition back to a prior version: deactivate the current
     * version, activate the target, and repoint `currentVersion` in one
     * transaction, so a reader never sees two active versions or a
     * `currentVersion` that names an inactive row. Returns a discriminated
     * result rather than throwing for the not-found cases the route reports as
     * 404 / 400.
     */
    async rollback(
      tenantId: string,
      definitionId: string,
      targetVersion: string,
    ): Promise<WorkflowDefinitionRollbackResult> {
      return db.transaction(async (tx) => {
        const existing = await tx.query.workflowDefinition.findFirst({
          where: and(
            eq(workflowDefinition.id, definitionId),
            eq(workflowDefinition.tenantId, tenantId),
          ),
        });
        if (existing === undefined) {
          return { ok: false, reason: "definition_not_found" };
        }

        const target = await tx.query.workflowDefinitionVersion.findFirst({
          where: and(
            eq(workflowDefinitionVersion.definitionId, definitionId),
            eq(workflowDefinitionVersion.version, targetVersion),
          ),
        });
        if (target === undefined) {
          return { ok: false, reason: "version_not_found" };
        }

        await tx
          .update(workflowDefinitionVersion)
          .set({ status: "inactive" })
          .where(
            and(
              eq(workflowDefinitionVersion.definitionId, definitionId),
              eq(workflowDefinitionVersion.version, existing.currentVersion),
            ),
          );
        await tx
          .update(workflowDefinitionVersion)
          .set({ status: "active" })
          .where(
            and(
              eq(workflowDefinitionVersion.definitionId, definitionId),
              eq(workflowDefinitionVersion.version, targetVersion),
            ),
          );

        const [updated] = await tx
          .update(workflowDefinition)
          .set({ currentVersion: targetVersion, updatedAt: new Date() })
          .where(eq(workflowDefinition.id, definitionId))
          .returning();
        if (updated === undefined) {
          throw new Error(
            `workflowDefinitionStore.rollback: update returned no row for ${definitionId}`,
          );
        }
        return { ok: true, definition: parseWorkflowDefinitionRow(updated) };
      });
    },
  };
}
