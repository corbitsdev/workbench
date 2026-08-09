// The create-agent-definition surface: a tenant member submits a
// name/handle/description/system-prompt/model, and this route
// materializes it exactly the way the platform's own starter agents
// (`@corbits/assistant-workflow`, `@corbits/chat`'s channel host) are
// materialized — a `workflow`-kind asset carrying a single-step
// `workflow.json`, projected onto a first-class `workflow_definition`
// row. No git subprocess: `AssetService.populateAsset` writes the
// commit in-process, the same seam `createAsset` used to hydrate a
// channel host's asset lives beside.
//
// The definition lands with the schema's own default status
// ("deployed") and a non-null assetId, which is exactly what
// `ChatPlatform.listInvitableDefinitions`/`launchInvite` require to
// treat it as launchable — a freshly created agent is invitable and
// launchable the moment this route returns, no separate "deploy" step.

import { type } from "arktype";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { DB } from "@intx/db";
import { workflowDefinition } from "@intx/db/schema";
import type { TenantEnv, RequireGrant } from "@intx/hub-api";
import {
  AssetServiceError,
  DEFAULT_ASSET_REF,
  ensureWorkflowDefinitionForAsset,
} from "@intx/hub-sessions";
import type { AssetService } from "@intx/hub-sessions";

import {
  buildAgentDefinitionWorkflow,
  serializeAgentDefinitionWorkflow,
} from "./agent-workflow";
import { CreateAgentDefinitionInput } from "./validation";

export type CreateAgentDefinitionRoutesDeps = {
  db: DB["db"];
  assetService: AssetService;
  requireGrant: RequireGrant;
};

function errorEnvelope(code: string, message: string) {
  return { error: { code, message } };
}

export function createAgentDefinitionRoutes({
  db,
  assetService,
  requireGrant,
}: CreateAgentDefinitionRoutesDeps): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.post("/", requireGrant("workflow-definition:*", "create"), async (c) => {
    const body = CreateAgentDefinitionInput(
      await c.req.json().catch(() => undefined),
    );
    if (body instanceof type.errors) {
      return c.json(
        errorEnvelope(
          "bad_request",
          `invalid agent definition: ${body.summary}`,
        ),
        400,
      );
    }

    const tenant = c.get("tenant");
    const principal = c.get("principal");

    const definition = buildAgentDefinitionWorkflow({
      handle: body.handle,
      tenantDomain: tenant.domain,
      description: body.description ?? "",
      systemPrompt: body.systemPrompt,
      ...(body.model !== undefined ? { model: body.model } : {}),
    });
    const workflowJson = serializeAgentDefinitionWorkflow(definition);

    let asset;
    try {
      asset = await assetService.createAsset({
        tenantId: tenant.id,
        kind: "workflow",
        name: body.handle,
        displayName: body.name,
        creatorPrincipalId: principal.id,
      });
    } catch (cause) {
      if (
        cause instanceof AssetServiceError &&
        cause.reason === "duplicate_asset"
      ) {
        return c.json(
          errorEnvelope(
            "conflict",
            `An agent with the handle "${body.handle}" already exists`,
          ),
          409,
        );
      }
      throw cause;
    }

    await assetService.populateAsset({
      assetId: asset.id,
      ref: DEFAULT_ASSET_REF,
      principal: { kind: "hub" },
      tree: {
        files: { "workflow.json": workflowJson },
        message: `Define agent ${body.name}`,
      },
    });

    const { definitionId } = await ensureWorkflowDefinitionForAsset(
      db,
      asset.id,
    );

    const row = await db.query.workflowDefinition.findFirst({
      where: and(
        eq(workflowDefinition.id, definitionId),
        eq(workflowDefinition.tenantId, tenant.id),
      ),
    });
    if (row === undefined) {
      throw new Error(
        `agent definition "${definitionId}" was created but is not readable back`,
      );
    }

    return c.json(
      {
        id: row.id,
        tenantId: row.tenantId,
        name: row.name,
        description: row.description ?? null,
        currentVersion: row.currentVersion,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
      201,
    );
  });

  return app;
}
