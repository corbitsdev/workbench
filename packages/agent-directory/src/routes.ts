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
import { idResource } from "@intx/hub-api";
import {
  AssetServiceError,
  DEFAULT_ASSET_REF,
  ensureWorkflowDefinitionForAsset,
} from "@intx/hub-sessions";
import type { AssetService } from "@intx/hub-sessions";
import { computeWireDefinitionHash } from "@intx/types/wire-definition-hash";

import {
  SkillRegistryError,
  type PinnedSkillIndexEntry,
} from "@corbits/skills";
import { isChannelHostDefinitionName } from "@corbits/chat/channel-host-naming";

import {
  buildAgentDefinitionWorkflow,
  readAgentCapabilities,
  readAgentSystemPrompt,
  reindexPinnedSkills,
  serializeAgentDefinitionWorkflow,
  withAgentModel,
  withAgentSystemPrompt,
  withAgentToolPackagePin,
} from "./agent-workflow";
import type { DefinitionSkillsStore } from "./skills-store";
import {
  CreateAgentDefinitionInput,
  RestoreDefinitionInput,
  UpdateAgentInstructionsInput,
  UpdateAgentSkillsInput,
} from "./validation";
import {
  AddCapabilityInput,
  assertCapabilityInInventory,
  CapabilityOutOfInventoryError,
  type CapabilityInventoryProvider,
} from "./capability-inventory";
import type { DefinitionAssetHistory } from "./definition-history";

/**
 * Resolves the pinned skill names a definition carries into the
 * name-and-description index its system prompt advertises. Required, not
 * optional: a definition pushed without a resolved index would carry
 * pins its agent has no way to discover.
 */
export type PinnedSkillIndexResolver = {
  resolve(
    tenantId: string,
    principalId: string,
    names: readonly string[],
  ): Promise<readonly PinnedSkillIndexEntry[]>;
};

export type CreateAgentDefinitionRoutesDeps = {
  db: DB["db"];
  assetService: AssetService;
  skillIndex: PinnedSkillIndexResolver;
  skillsStore: DefinitionSkillsStore;
  history: DefinitionAssetHistory;
  capabilityInventory: CapabilityInventoryProvider;
  requireGrant: RequireGrant;
};

/** Where a definition's serialized `WorkflowDefinition` lives in its asset tree. */
const AGENT_DEFINITION_ASSET_PATH = "workflow.json";

function errorEnvelope(code: string, message: string) {
  return { error: { code, message } };
}

/** The same 404 shape a missing definition gets — deliberately reused
 * for a channel host's definition too (see `hostGuardedRow`), so a
 * caller cannot distinguish "no such definition" from "that id names a
 * channel host" by response shape alone. */
function definitionNotFound(definitionId: string) {
  return errorEnvelope(
    "not_found",
    `No agent definition "${definitionId}" in this workbench`,
  );
}

/**
 * A channel host is a single-step workflow definition exactly like a
 * hand-authored agent, but it is the channel's own silent anchor, never
 * a participant a person edits through this surface — rewriting its
 * system prompt would turn a silent anchor into a responder. Refused
 * the same way a missing definition is: 404, not 403, so the row's
 * existence isn't leaked either.
 */
function hostGuardedRow(
  row: { readonly name: string; readonly assetId: string | null } | undefined,
): row is { readonly name: string; readonly assetId: string } {
  return (
    row !== undefined &&
    row.assetId !== null &&
    !isChannelHostDefinitionName(row.name)
  );
}

export function createAgentDefinitionRoutes({
  db,
  assetService,
  skillIndex,
  skillsStore,
  history,
  capabilityInventory,
  requireGrant,
}: CreateAgentDefinitionRoutesDeps): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  // Pinning a name the registry cannot resolve, or requesting a
  // capability out of the tenant's live inventory, is a bad request from
  // the person editing the agent, not a server fault — surface either as
  // one rather than letting it read as a 500.
  app.onError((err, c) => {
    if (err instanceof SkillRegistryError) {
      return c.json(errorEnvelope("bad_request", err.message), 400);
    }
    if (err instanceof CapabilityOutOfInventoryError) {
      return c.json(errorEnvelope("bad_request", err.message), 400);
    }
    throw err;
  });

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

    const skills = body.skills ?? [];
    const baseDefinitionInput = {
      handle: body.handle,
      tenantDomain: tenant.domain,
      description: body.description ?? "",
      systemPrompt: body.systemPrompt,
    };
    const definition = buildAgentDefinitionWorkflow(
      body.model !== undefined
        ? { ...baseDefinitionInput, model: body.model }
        : baseDefinitionInput,
    );
    // The definition's own system prompt is what the author typed; the
    // pinned-skills index is appended on the way to the asset so the
    // stored prompt always describes exactly the skills the definition
    // currently pins.
    const workflowJson = reindexPinnedSkills(
      serializeAgentDefinitionWorkflow(definition),
      await skillIndex.resolve(tenant.id, principal.id, skills),
    );

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
          [AGENT_DEFINITION_ASSET_PATH]: workflowJson,
        },
        message: `Define agent ${body.name}`,
      },
    });
    await skillsStore.setSkills(assetId, skills);

    const wireHash = await computeWireDefinitionHash(JSON.parse(workflowJson));
    const { definitionId } = await ensureWorkflowDefinitionForAsset(db, {
      assetId,
      wireHash,
    });

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
          const skills = await skillsStore.getSkills(row.assetId);
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

  // Feeds the settings surface's guided capability-add picker with only
  // what this tenant actually has — the same source `POST
  // /:definitionId/capabilities` re-checks fail-closed on the add itself,
  // so a name this call doesn't list can never be added either.
  app.get(
    "/capabilities/inventory",
    requireGrant("workflow-definition:*", "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const inventory = await capabilityInventory.resolve({
        tenantId: tenant.id,
        principalId: principal.id,
      });
      return c.json(inventory);
    },
  );

  app.get(
    "/:definitionId",
    requireGrant(idResource("workflow-definition", "definitionId"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const definitionId = c.req.param("definitionId");
      const row = await db.query.workflowDefinition.findFirst({
        where: and(
          eq(workflowDefinition.id, definitionId),
          eq(workflowDefinition.tenantId, tenant.id),
        ),
      });
      if (!hostGuardedRow(row)) {
        return c.json(definitionNotFound(definitionId), 404);
      }

      const workflowJson = new TextDecoder().decode(
        await assetService.readAssetBlob({
          assetId: row.assetId,
          path: AGENT_DEFINITION_ASSET_PATH,
        }),
      );
      const capabilities = readAgentCapabilities(workflowJson);
      const skills = await skillsStore.getSkills(row.assetId);

      return c.json({
        id: row.id,
        name: row.description ?? row.name,
        systemPrompt: readAgentSystemPrompt(workflowJson),
        toolPackagePins: capabilities.toolPackagePins,
        skills,
        model: capabilities.model,
      });
    },
  );

  app.get(
    "/:definitionId/versions",
    requireGrant(idResource("workflow-definition", "definitionId"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const definitionId = c.req.param("definitionId");
      const row = await db.query.workflowDefinition.findFirst({
        where: and(
          eq(workflowDefinition.id, definitionId),
          eq(workflowDefinition.tenantId, tenant.id),
        ),
      });
      if (!hostGuardedRow(row)) {
        return c.json(definitionNotFound(definitionId), 404);
      }

      const commits = await history.history(row.assetId);
      const versions = commits.map((commit, index) => ({
        ...commit,
        current: index === 0,
      }));
      return c.json({ versions });
    },
  );

  app.post(
    "/:definitionId/restore",
    requireGrant(idResource("workflow-definition", "definitionId"), "update"),
    async (c) => {
      const body = RestoreDefinitionInput(
        await c.req.json().catch(() => undefined),
      );
      if (body instanceof type.errors) {
        return c.json(
          errorEnvelope("bad_request", `invalid restore: ${body.summary}`),
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
      if (!hostGuardedRow(row)) {
        return c.json(definitionNotFound(definitionId), 404);
      }

      const workflowBytes = await history.readBlobAtCommit({
        assetId: row.assetId,
        path: AGENT_DEFINITION_ASSET_PATH,
        commitSha: body.commitSha,
      });
      if (workflowBytes === null) {
        return c.json(
          errorEnvelope(
            "not_found",
            `agent "${row.name}" has no instructions at that point in its history`,
          ),
          404,
        );
      }
      const decoder = new TextDecoder();

      // Pinned skills live outside the asset tree (see
      // `DefinitionSkillsStore`), so restoring a prior commit only ever
      // rewrites `workflow.json` — the definition's currently pinned
      // skills are untouched by restoring an earlier instructions
      // revision.
      await assetService.populateAsset({
        assetId: row.assetId,
        ref: DEFAULT_ASSET_REF,
        principal: { kind: "hub" },
        tree: {
          files: {
            [AGENT_DEFINITION_ASSET_PATH]: decoder.decode(workflowBytes),
          },
          message: `Restore agent ${row.name} to ${body.commitSha.slice(0, 8)}`,
        },
      });

      const restoredWorkflowJson = new TextDecoder().decode(
        await assetService.readAssetBlob({
          assetId: row.assetId,
          path: AGENT_DEFINITION_ASSET_PATH,
        }),
      );
      const capabilities = readAgentCapabilities(restoredWorkflowJson);
      const skills = await skillsStore.getSkills(row.assetId);

      return c.json({
        id: row.id,
        name: row.description ?? row.name,
        systemPrompt: readAgentSystemPrompt(restoredWorkflowJson),
        toolPackagePins: capabilities.toolPackagePins,
        skills,
        model: capabilities.model,
      });
    },
  );

  app.post(
    "/:definitionId/capabilities",
    requireGrant(idResource("workflow-definition", "definitionId"), "update"),
    async (c) => {
      const body = AddCapabilityInput(
        await c.req.json().catch(() => undefined),
      );
      if (body instanceof type.errors) {
        return c.json(
          errorEnvelope("bad_request", `invalid capability: ${body.summary}`),
          400,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const definitionId = c.req.param("definitionId");
      const row = await db.query.workflowDefinition.findFirst({
        where: and(
          eq(workflowDefinition.id, definitionId),
          eq(workflowDefinition.tenantId, tenant.id),
        ),
      });
      if (!hostGuardedRow(row)) {
        return c.json(definitionNotFound(definitionId), 404);
      }

      const inventory = await capabilityInventory.resolve({
        tenantId: tenant.id,
        principalId: principal.id,
      });
      // Throws `CapabilityOutOfInventoryError`, caught by `app.onError`
      // above — fail closed against exactly the inventory this call just
      // fetched, never a stale or wider one.
      assertCapabilityInInventory(body, inventory);

      const workflowJson = new TextDecoder().decode(
        await assetService.readAssetBlob({
          assetId: row.assetId,
          path: AGENT_DEFINITION_ASSET_PATH,
        }),
      );

      let nextWorkflowJson: string;
      let message: string;
      let skills = await skillsStore.getSkills(row.assetId);
      let nextSkills: readonly string[] | null = null;

      switch (body.kind) {
        case "toolPackage": {
          nextWorkflowJson = withAgentToolPackagePin(workflowJson, {
            name: body.name,
            version: "*",
          });
          message = `Add ${body.name} to ${row.name}`;
          break;
        }
        case "skill": {
          nextSkills = skills.includes(body.name)
            ? skills
            : [...skills, body.name];
          nextWorkflowJson = reindexPinnedSkills(
            workflowJson,
            await skillIndex.resolve(tenant.id, principal.id, nextSkills),
          );
          skills = nextSkills;
          message = `Add ${body.name} skill to ${row.name}`;
          break;
        }
        case "model": {
          nextWorkflowJson = withAgentModel(workflowJson, body.canonicalName);
          message = `Set ${row.name}'s model to ${body.canonicalName}`;
          break;
        }
      }

      await assetService.populateAsset({
        assetId: row.assetId,
        ref: DEFAULT_ASSET_REF,
        principal: { kind: "hub" },
        tree: {
          files: { [AGENT_DEFINITION_ASSET_PATH]: nextWorkflowJson },
          message,
        },
      });
      if (nextSkills !== null) {
        await skillsStore.setSkills(row.assetId, nextSkills);
      }

      const capabilities = readAgentCapabilities(nextWorkflowJson);
      return c.json({
        toolPackagePins: capabilities.toolPackagePins,
        skills,
        model: capabilities.model,
      });
    },
  );

  app.put(
    "/:definitionId",
    requireGrant(idResource("workflow-definition", "definitionId"), "update"),
    async (c) => {
      const body = UpdateAgentInstructionsInput(
        await c.req.json().catch(() => undefined),
      );
      if (body instanceof type.errors) {
        return c.json(
          errorEnvelope(
            "bad_request",
            `invalid agent instructions: ${body.summary}`,
          ),
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
      if (!hostGuardedRow(row)) {
        return c.json(definitionNotFound(definitionId), 404);
      }

      const workflowJson = new TextDecoder().decode(
        await assetService.readAssetBlob({
          assetId: row.assetId,
          path: AGENT_DEFINITION_ASSET_PATH,
        }),
      );

      // Git first: the row updates below are what can still be retried
      // safely if they fail after this succeeds (see the catch below) —
      // the reverse order would leave a renamed row pointing at
      // instructions that were never actually written.
      await assetService.populateAsset({
        assetId: row.assetId,
        ref: DEFAULT_ASSET_REF,
        principal: { kind: "hub" },
        tree: {
          files: {
            [AGENT_DEFINITION_ASSET_PATH]: withAgentSystemPrompt(
              workflowJson,
              body.systemPrompt,
            ),
          },
          message: `Update agent instructions for ${row.name}`,
        },
      });

      const now = new Date();
      try {
        await db.transaction(async (tx) => {
          await tx
            .update(workflowDefinition)
            .set({ description: body.name, updatedAt: now })
            .where(
              and(
                eq(workflowDefinition.id, definitionId),
                eq(workflowDefinition.tenantId, tenant.id),
              ),
            );
          await tx
            .update(asset)
            .set({ displayName: body.name, updatedAt: now })
            .where(eq(asset.id, row.assetId));
        });
      } catch {
        return c.json(
          errorEnvelope(
            "partial_failure",
            `The instructions saved, but renaming "${row.name}" to ` +
              `"${body.name}" failed — the agent now answers with the new ` +
              `instructions under its old name. Retry to finish the rename.`,
          ),
          500,
        );
      }

      return c.json({ name: body.name, systemPrompt: body.systemPrompt });
    },
  );

  app.put(
    "/:definitionId/skills",
    requireGrant(idResource("workflow-definition", "definitionId"), "update"),
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

      const principal = c.get("principal");
      const workflowJson = new TextDecoder().decode(
        await assetService.readAssetBlob({
          assetId: row.assetId,
          path: AGENT_DEFINITION_ASSET_PATH,
        }),
      );

      await assetService.populateAsset({
        assetId: row.assetId,
        ref: DEFAULT_ASSET_REF,
        principal: { kind: "hub" },
        tree: {
          files: {
            [AGENT_DEFINITION_ASSET_PATH]: reindexPinnedSkills(
              workflowJson,
              await skillIndex.resolve(tenant.id, principal.id, body.skills),
            ),
          },
          message: `Update agent skills for ${row.name}`,
        },
      });
      await skillsStore.setSkills(row.assetId, body.skills);

      return c.json({ skills: body.skills });
    },
  );

  return app;
}
