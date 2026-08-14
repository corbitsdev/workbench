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
import { asset, workflowDefinition } from "@intx/db/schema";
import type { TenantEnv, RequireGrant } from "@intx/hub-api";
import {
  AssetServiceError,
  DEFAULT_ASSET_REF,
  ensureWorkflowDefinitionForAsset,
} from "@intx/hub-sessions";
import type { AssetService } from "@intx/hub-sessions";

import {
  AGENT_SKILLS_ASSET_PATH,
  buildAgentDefinitionWorkflow,
  parseAgentSkills,
  serializeAgentDefinitionWorkflow,
  serializeAgentSkills,
} from "./agent-workflow";
import {
  CreateAgentDefinitionInput,
  UpdateAgentSkillsInput,
} from "./validation";

/** Reads a definition's attached skills back from its asset tree.
 * A definition created before this feature existed (or one that has
 * never had skills attached) has no `skills.json` at all — that reads
 * as "no skills attached", not an error. Any other asset-service failure
 * propagates. */
async function readDefinitionSkills(
  assetService: AssetService,
  assetId: string,
): Promise<readonly string[]> {
  let bytes: Uint8Array;
  try {
    bytes = await assetService.readAssetBlob({
      assetId,
      path: AGENT_SKILLS_ASSET_PATH,
    });
  } catch (cause) {
    if (cause instanceof AssetServiceError && cause.reason === "not_found") {
      return [];
    }
    throw cause;
  }
  return parseAgentSkills(bytes);
}

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
    const skills = body.skills ?? [];
    const skillsJson = serializeAgentSkills(skills);

    let assetId: string;
    try {
      const created = await assetService.createAsset({
        tenantId: tenant.id,
        kind: "workflow",
        name: body.handle,
        displayName: body.name,
        creatorPrincipalId: principal.id,
      });
      assetId = created.id;
    } catch (cause) {
      if (
        cause instanceof AssetServiceError &&
        cause.reason === "duplicate_asset"
      ) {
        // A previous attempt may have created the asset row but failed
        // before populateAsset wrote workflow.json — an empty shell that
        // blocks retries with a misleading 409. Recover: look up the
        // existing asset and reuse it only if it has no definition yet.
        const existing = await db.query.asset.findFirst({
          where: and(
            eq(asset.tenantId, tenant.id),
            eq(asset.kind, "workflow"),
            eq(asset.name, body.handle),
          ),
        });
        if (existing) {
          const hasDef = await db.query.workflowDefinition.findFirst({
            where: and(
              eq(workflowDefinition.assetId, existing.id),
              eq(workflowDefinition.tenantId, tenant.id),
            ),
          });
          if (!hasDef) {
            assetId = existing.id;
          } else {
            return c.json(
              errorEnvelope(
                "conflict",
                `An agent with the handle "${body.handle}" already exists`,
              ),
              409,
            );
          }
        } else {
          return c.json(
            errorEnvelope(
              "conflict",
              `An agent with the handle "${body.handle}" already exists`,
            ),
            409,
          );
        }
      } else {
        throw cause;
      }
    }

    await assetService.populateAsset({
      assetId,
      ref: DEFAULT_ASSET_REF,
      principal: { kind: "hub" },
      tree: {
        files: {
          "workflow.json": workflowJson,
          [AGENT_SKILLS_ASSET_PATH]: skillsJson,
        },
        message: `Define agent ${body.name}`,
      },
    });

    const { definitionId } = await ensureWorkflowDefinitionForAsset(
      db,
      assetId,
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
        skills,
      },
      201,
    );
  });

  app.get(
    "/skills",
    requireGrant("workflow-definition:*", "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const idsParam = c.req.query("ids") ?? "";
      const ids = [
        ...new Set(
          idsParam
            .split(",")
            .map((id) => id.trim())
            .filter((id) => id !== ""),
        ),
      ];

      const entries = await Promise.all(
        ids.map(async (definitionId) => {
          const row = await db.query.workflowDefinition.findFirst({
            where: and(
              eq(workflowDefinition.id, definitionId),
              eq(workflowDefinition.tenantId, tenant.id),
            ),
          });
          if (row === undefined || row.assetId === null) return null;
          const skills = await readDefinitionSkills(assetService, row.assetId);
          return [definitionId, skills] as const;
        }),
      );

      const skills: Record<string, readonly string[]> = {};
      for (const entry of entries) {
        if (entry !== null) skills[entry[0]] = entry[1];
      }
      return c.json({ skills });
    },
  );

  app.put(
    "/:definitionId/skills",
    requireGrant("workflow-definition:*", "update"),
    async (c) => {
      const body = UpdateAgentSkillsInput(
        await c.req.json().catch(() => undefined),
      );
      if (body instanceof type.errors) {
        return c.json(
          errorEnvelope("bad_request", `invalid skills list: ${body.summary}`),
          400,
        );
      }

      const tenant = c.get("tenant");
      const definitionId = c.req.param("definitionId");
      const row = await db.query.workflowDefinition.findFirst({
        where: and(
          eq(workflowDefinition.id, definitionId),
          eq(workflowDefinition.tenantId, tenant.id),
        ),
      });
      if (row === undefined || row.assetId === null) {
        return c.json(
          errorEnvelope(
            "not_found",
            `No agent definition "${definitionId}" in this workbench`,
          ),
          404,
        );
      }

      await assetService.populateAsset({
        assetId: row.assetId,
        ref: DEFAULT_ASSET_REF,
        principal: { kind: "hub" },
        tree: {
          files: {
            [AGENT_SKILLS_ASSET_PATH]: serializeAgentSkills(body.skills),
          },
          message: `Update agent skills for ${row.name}`,
        },
      });

      return c.json({ skills: body.skills });
    },
  );

  return app;
}
