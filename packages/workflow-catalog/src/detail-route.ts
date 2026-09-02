// GET /api/tenants/:tenantId/workflows/definitions/:definitionAssetId/detail
// — the one read a workflow's own detail page (`apps/web/src/pages/
// workflow-detail-page.tsx`) needs: what it is, whether it can run right
// now, its steps in execution order, and its access surface (declared vs.
// approved grants, credential binding names — never a value). Mounted
// alongside the vendored `createWorkflowDefinitionRoutes` at
// `${TENANT_PREFIX}/workflows/definitions` (`apps/hub/src/index.ts`), not
// inside it: this is a Workbench-owned read composed over native rows plus
// `@corbits/workflow-deploy-source`'s deploy-attempt record, not something
// `vendor/intx/hub-api` knows about.
//
// Every field is read-only and native: `workflow_definition` /
// `workflow_definition_version` (via `@intx/db`'s `loadFrozenGrantSnapshot`
// / `loadFrozenWireProjection`, the same freeze-transaction reads the run
// path uses) and `asset` for the display name. `workflow.json` is never
// read (see docs/workflow-model.md's retirement).
import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { DB } from "@intx/db";
import {
  loadFrozenGrantSnapshot,
  loadFrozenWireProjection,
  parseWorkflowDefinitionRow,
  schema,
} from "@intx/db";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import { idResource } from "@intx/hub-api";
import type { WorkflowDeploySourceDb } from "@corbits/workflow-deploy-source";
import { workflowDeploySource } from "@corbits/workflow-deploy-source";

import { deriveWorkflowLifecycle } from "./definition-lifecycle";
import type { WorkflowDefinitionDetail } from "./definition-detail";

export type CreateWorkflowDetailRouteDeps = {
  db: DB["db"];
  requireGrant: RequireGrant;
};

/** Best-effort read of one wire step's role/director/model/toolPins — the
 * wire projection's `steps` map is deliberately open-schema (see
 * `vendor/intx/types/src/wire-workflow.ts`'s `WorkflowStep`: only `kind`
 * and `id`/`after` are validated, everything else passes through
 * unmodified), so this never throws on a shape it doesn't recognize; an
 * absent field just reads empty rather than failing the whole request. */
function projectStep(
  stepId: string,
  raw: unknown,
  perStepGrants: ReadonlyMap<string, readonly string[]>,
): WorkflowDefinitionDetail["steps"][number] {
  const step =
    raw !== null && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : {};
  const agent =
    step.agent !== null && typeof step.agent === "object"
      ? (step.agent as Record<string, unknown>)
      : {};
  const role = typeof step.kind === "string" ? step.kind : "step";
  const model = typeof agent.model === "string" ? agent.model : null;
  const director =
    typeof agent.director === "string"
      ? agent.director
      : typeof agent.name === "string"
        ? agent.name
        : null;
  const toolPins = Array.isArray(agent.toolPins)
    ? agent.toolPins
        .map((pin) =>
          typeof pin === "string"
            ? pin
            : pin !== null &&
                typeof pin === "object" &&
                typeof (pin as { name?: unknown }).name === "string"
              ? (pin as { name: string }).name
              : null,
        )
        .filter((name): name is string => name !== null)
    : [];
  return {
    id: stepId,
    role,
    ...(director !== null ? { director } : {}),
    ...(model !== null ? { model } : {}),
    toolPins,
    grants: [...(perStepGrants.get(stepId) ?? [])],
  };
}

/** The `WorkflowDefinitionAssetSource` `package.commitSha`, when the deploy
 * source names a source-tree package at a pinned commit — `""` for every
 * other source shape (a registry pin, or a tarball package, neither of
 * which carries a commit sha). Read defensively: `source` is a jsonb
 * column typed as `WorkflowDefinitionSource` only by convention, not
 * re-validated here. */
function commitShaFromSource(source: unknown): string {
  if (source === null || typeof source !== "object") return "";
  const pkg = (source as Record<string, unknown>).package;
  if (pkg === null || typeof pkg !== "object") return "";
  const commitSha = (pkg as Record<string, unknown>).commitSha;
  return typeof commitSha === "string" ? commitSha : "";
}

function originFromSource(source: unknown): string {
  if (source === null || typeof source !== "object") return "unknown";
  const kind = (source as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : "unknown";
}

export function createWorkflowDetailRoute({
  db,
  requireGrant,
}: CreateWorkflowDetailRouteDeps): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.get(
    "/:definitionAssetId/detail",
    requireGrant(
      idResource("workflow-definition", "definitionAssetId"),
      "read",
    ),
    async (c) => {
      const tenantCtx = c.get("tenant");
      const definitionAssetId = c.req.param("definitionAssetId");

      const asset = await db.query.asset.findFirst({
        where: and(
          eq(schema.asset.id, definitionAssetId),
          eq(schema.asset.tenantId, tenantCtx.id),
        ),
      });
      if (asset === undefined) {
        return c.json(
          { error: { code: "not_found", message: "Workflow not found" } },
          404,
        );
      }

      const definitionRows = (
        await db.query.workflowDefinition.findMany({
          where: and(
            eq(schema.workflowDefinition.assetId, definitionAssetId),
            eq(schema.workflowDefinition.tenantId, tenantCtx.id),
          ),
          orderBy: desc(schema.workflowDefinition.createdAt),
        })
      ).map(parseWorkflowDefinitionRow);

      const versionRows =
        definitionRows.length === 0
          ? []
          : await db.query.workflowDefinitionVersion.findMany({
              where: inArray(
                schema.workflowDefinitionVersion.definitionId,
                definitionRows.map((row) => row.id),
              ),
            });
      const currentVersionByDefinitionId = new Map(
        definitionRows.map((row) => [
          row.id,
          versionRows.find(
            (v) =>
              v.definitionId === row.id && v.version === row.currentVersion,
          ),
        ]),
      );

      const deploySourceRows = await (
        db as unknown as WorkflowDeploySourceDb<Record<string, unknown>>
      )
        .select()
        .from(workflowDeploySource)
        .where(
          and(
            eq(workflowDeploySource.definitionAssetId, definitionAssetId),
            eq(workflowDeploySource.tenantId, tenantCtx.id),
          ),
        )
        .orderBy(desc(workflowDeploySource.recordedAt))
        .limit(1);
      const deploySource = deploySourceRows[0] ?? null;

      const { lifecycle, currentDefinitionId, wireHash } =
        deriveWorkflowLifecycle(
          definitionRows.map((row) => ({
            id: row.id,
            wireHash: row.wireHash,
            approvedWireHash:
              currentVersionByDefinitionId.get(row.id)?.approvedWireHash ??
              null,
            status: row.status,
            createdAt: row.createdAt.toISOString(),
          })),
          deploySource !== null,
        );

      const current = definitionRows.find(
        (row) => row.id === currentDefinitionId,
      );
      const grantSnapshot =
        current !== undefined
          ? await loadFrozenGrantSnapshot(db, current.id)
          : null;
      const wireProjection =
        current !== undefined
          ? await loadFrozenWireProjection(db, current.id)
          : null;

      const perStepGrants = new Map<string, readonly string[]>(
        (grantSnapshot?.perStep ?? []).map((step) => [
          step.stepId,
          step.grants,
        ]),
      );
      const steps =
        wireProjection === null
          ? []
          : wireProjection.stepOrder.map((stepId) =>
              projectStep(stepId, wireProjection.steps[stepId], perStepGrants),
            );

      const declaredGrants = current?.grantRequirements ?? [];
      const approvedGrants = grantSnapshot?.grantRequirements ?? [];
      const credentialBindings = current?.credentialBindings ?? [];
      const declaredGrantNames = declaredGrants.map(
        (g) => `${g.resource}:${g.action}`,
      );
      const approvedGrantNames = approvedGrants.map(
        (g) => `${g.resource}:${g.action}`,
      );
      const credentialBindingNames = credentialBindings.map((b) => b.handle);

      const body: WorkflowDefinitionDetail = {
        definitionAssetId,
        assetName: asset.name,
        displayName: asset.displayName ?? asset.name,
        ...(current?.description !== undefined && current.description !== null
          ? { description: current.description }
          : {}),
        lifecycle,
        ...(currentDefinitionId !== null ? { currentDefinitionId } : {}),
        ...(wireHash !== null ? { wireHash } : {}),
        ...(deploySource !== null
          ? {
              source: {
                commitSha: commitShaFromSource(deploySource.source),
                entry: deploySource.entry,
                origin: originFromSource(deploySource.source),
              },
            }
          : { source: null }),
        steps,
        grants: {
          declared: declaredGrantNames,
          approved: approvedGrantNames,
        },
        credentialBindings: credentialBindingNames,
      };

      return c.json(body);
    },
  );

  return app;
}
