// The create-agent-definition surface: materializes a submitted definition
// as a `workflow`-kind asset. Lands `deployed` with a non-null assetId, so
// a freshly created agent is invitable and launchable immediately.

import { type } from "arktype";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { DB } from "@intx/db";
import { asset, workflowDefinition } from "@intx/db/schema";
import type { TenantEnv, RequireGrant } from "@intx/hub-api";
import { idResource } from "@intx/hub-api";
import { DEFAULT_ASSET_REF } from "@intx/hub-sessions";
import type { AssetService } from "@intx/hub-sessions";

import { type PinnedSkillIndexEntry } from "@corbits/skills-tools";

import {
  createAgentDefinitionCore,
  DuplicateAgentHandleError,
  readAgentCapabilities,
  readAgentSystemPrompt,
  readPinnedSkillNames,
  reindexPinnedSkills,
  withAgentSystemPrompt,
  withoutAgentModel,
  type CreateAgentDefinitionCoreDeps,
  type CreateAgentDefinitionCoreInput,
} from "./agent-workflow";
import { commitLatestAgentAssetSnapshot } from "./asset-write";
import { commitAgentCapabilityAdd } from "./capability-add";
import {
  agentDefinitionSourceTree,
  AGENT_DEFINITION_ENTRY_PATH,
  parseAgentDefinitionEntry,
  readAgentDefinitionWorkflowJson,
  RetiredWorkflowEnvelopeError,
  statusForAgentDefinitionDeployError,
  writeAndDeployAgentDefinition,
  WorkflowAuthorError,
  type AgentDefinitionDeployer,
} from "./definition-asset";
import {
  CreateAgentDefinitionInput,
  RestoreDefinitionInput,
  UpdateAgentInstructionsInput,
  UpdateAgentSkillsInput,
  UpdateDefinitionStatusInput,
} from "./validation";
import {
  AddCapabilityInput,
  assertCapabilityInInventory,
  CapabilityOutOfInventoryError,
  type CapabilityInventoryProvider,
} from "./capability-inventory";
import type { DefinitionAssetHistory } from "./definition-history";
import { listVisibleAgentDefinitions } from "./visible-definitions";
import { reportError } from "@corbits/error-sink";
import { makeErrorEnvelope } from "@corbits/error-sink";

/** Resolves pinned skill names into the name-and-description index the
 * system prompt advertises. Required, not optional. */
export type PinnedSkillIndexResolver = {
  resolve(
    tenantId: string,
    principalId: string,
    names: readonly string[],
  ): Promise<readonly PinnedSkillIndexEntry[]>;
};

/** Thrown by a `PinnedSkillIndexResolver` when a pinned name can't be
 * resolved against the tenant's native skill assets — a bad request from
 * the person editing the agent, not a server fault. */
export class SkillIndexResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillIndexResolutionError";
  }
}

export type CreateAgentDefinitionRoutesDeps = {
  db: DB["db"];
  assetService: AssetService;
  skillIndex: PinnedSkillIndexResolver;
  history: DefinitionAssetHistory;
  capabilityInventory: CapabilityInventoryProvider;
  requireGrant: RequireGrant;
  /** Deploys the definition's commit through the native source pipeline
   * on every content write. */
  deployer: AgentDefinitionDeployer;
  tenantDefaultModel?: CreateAgentDefinitionCoreDeps["tenantDefaultModel"];
};

/** The same 404 shape reused for a workbench host's definition (see
 * `hostGuardedRow`), so response shape can't distinguish the two. */
function definitionNotFound(definitionId: string) {
  return makeErrorEnvelope({
    code: "not_found",
    userMessage: `No agent definition "${definitionId}" in this workbench`,
  });
}

/** A workbench host is never editable through this surface. Refused the
 * same way a missing definition is: 404, not 403. */
function hostGuardedRow(
  row: { readonly name: string; readonly assetId: string | null } | undefined,
): row is { readonly name: string; readonly assetId: string } {
  return row !== undefined && row.assetId !== null;
}

export function createAgentDefinitionRoutes({
  db,
  assetService,
  skillIndex,
  history,
  capabilityInventory,
  requireGrant,
  deployer,
  tenantDefaultModel,
}: CreateAgentDefinitionRoutesDeps): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  // Pinning a name the registry cannot resolve, or requesting a
  // capability out of the tenant's live inventory, is a bad request from
  // the person editing the agent, not a server fault — surface either as
  // one rather than letting it read as a 500.
  app.onError((err, c) => {
    if (err instanceof SkillIndexResolutionError) {
      return c.json(makeErrorEnvelope({ code: "bad_request", userMessage: err.message }), 400);
    }
    if (err instanceof CapabilityOutOfInventoryError) {
      return c.json(makeErrorEnvelope({ code: "bad_request", userMessage: err.message }), 400);
    }
    if (err instanceof RetiredWorkflowEnvelopeError) {
      return c.json(makeErrorEnvelope({ code: "conflict", userMessage: err.message }), 409);
    }
    if (err instanceof WorkflowAuthorError) {
      return c.json(
        makeErrorEnvelope({ code: err.reason, userMessage: err.message }),
        statusForAgentDefinitionDeployError(err.reason),
      );
    }
    throw err;
  });

  app.post("/", requireGrant("workflow-definition:*", "create"), async (c) => {
    const body = CreateAgentDefinitionInput(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `invalid agent definition: ${body.summary}`,
        }),
        400,
      );
    }

    const tenant = c.get("tenant");
    const principal = c.get("principal");

    const skills = body.skills ?? [];
    // Built up mutably, not as one literal: `exactOptionalPropertyTypes`
    // needs an absent `description`/`model` to be an absent key.
    const coreInput: {
      -readonly [K in keyof CreateAgentDefinitionCoreInput]: CreateAgentDefinitionCoreInput[K];
    } = {
      tenantId: tenant.id,
      principalId: principal.id,
      tenantDomain: tenant.domain,
      handle: body.handle,
      name: body.name,
      systemPrompt: body.systemPrompt,
      skills,
    };
    if (body.description !== undefined) coreInput.description = body.description;
    if (body.model !== undefined) coreInput.model = body.model;
    if (body.toolPackagePins !== undefined && body.toolPackagePins.length > 0) {
      coreInput.toolPackagePins = body.toolPackagePins;
    }

    let row: Awaited<ReturnType<typeof createAgentDefinitionCore>>["row"];
    try {
      ({ row } = await createAgentDefinitionCore(
        {
          db,
          assetService,
          skillIndex,
          deployer,
          ...(tenantDefaultModel !== undefined ? { tenantDefaultModel } : {}),
        },
        coreInput,
      ));
    } catch (cause) {
      if (cause instanceof DuplicateAgentHandleError) {
        return c.json(makeErrorEnvelope({ code: "conflict", userMessage: cause.message }), 409);
      }
      throw cause;
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

  app.get("/skills", requireGrant("workflow-definition:*", "read"), async (c) => {
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
        try {
          const row = await db.query.workflowDefinition.findFirst({
            where: and(
              eq(workflowDefinition.id, definitionId),
              eq(workflowDefinition.tenantId, tenant.id),
            ),
          });
          if (row === undefined || row.assetId === null) return null;
          // One unreadable asset must not fail the whole batch — skip,
          // report, serve the healthy ones.
          const workflowJson = await readAgentDefinitionWorkflowJson(assetService, row.assetId);
          const skills = readPinnedSkillNames(workflowJson);
          return [definitionId, skills] as const;
        } catch (err) {
          reportError(err, {
            operation: "agentDirectory.bulkSkills",
            tenantId: tenant.id,
            extra: { definitionId },
          });
          return null;
        }
      }),
    );

    const skills: Record<string, readonly string[]> = {};
    for (const entry of entries) {
      if (entry !== null) skills[entry[0]] = entry[1];
    }
    return c.json({ skills });
  });

  // Feeds the guided capability-add picker with only what this tenant has;
  // the add route re-checks fail-closed against the same source.
  app.get("/capabilities/inventory", requireGrant("workflow-definition:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const inventory = await capabilityInventory.resolve({
      tenantId: tenant.id,
      principalId: principal.id,
    });
    return c.json(inventory);
  });

  // Every agent this tenant can open a direct chat with, keyed by
  // `tenantId` per row so a click mints the DM in the right tenant.
  app.get("/visible", requireGrant("workflow-definition:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const definitions = await listVisibleAgentDefinitions(db, tenant.id);
    return c.json({ definitions });
  });

  // Resolves the immutable slug directly rather than scanning the
  // listing, so an agent past its pagination ceiling still resolves.
  app.get("/by-name/:name", requireGrant("workflow-definition:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const name = c.req.param("name");
    const row = await db.query.workflowDefinition.findFirst({
      where: and(eq(workflowDefinition.name, name), eq(workflowDefinition.tenantId, tenant.id)),
    });
    if (!hostGuardedRow(row)) {
      return c.json(definitionNotFound(name), 404);
    }

    return c.json({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      description: row.description ?? null,
      currentVersion: row.currentVersion,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  });

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

      const workflowJson = await readAgentDefinitionWorkflowJson(assetService, row.assetId);
      const capabilities = readAgentCapabilities(workflowJson);
      // Pins read out of the asset's own stanza: deleting the side
      // table leaves this surface's only skills source the snapshot
      // every write reindexes.
      const skills = readPinnedSkillNames(workflowJson);

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
      const body = RestoreDefinitionInput(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid restore: ${body.summary}`,
          }),
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

      const entryBytes = await history.readBlobAtCommit({
        assetId: row.assetId,
        path: AGENT_DEFINITION_ENTRY_PATH,
        commitSha: body.commitSha,
      });
      if (entryBytes === null) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: `agent "${row.name}" has no instructions at that point in its history`,
          }),
          404,
        );
      }
      const restoredWorkflowJson = parseAgentDefinitionEntry(entryBytes, row.assetId);

      // Pins live in the asset's own stanza (reindexed on every write),
      // so restoring a prior commit restores that revision's pins with
      // the source tree — there is no side table left to stay behind.
      await writeAndDeployAgentDefinition({
        assetService,
        deployer,
        tenantId: tenant.id,
        principalId: principal.id,
        assetId: row.assetId,
        handle: row.name,
        workflowJson: restoredWorkflowJson,
        message: `Restore agent ${row.name} to ${body.commitSha.slice(0, 8)}`,
      });

      const capabilities = readAgentCapabilities(restoredWorkflowJson);
      const skills = readPinnedSkillNames(restoredWorkflowJson);

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
      const body = AddCapabilityInput(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid capability: ${body.summary}`,
          }),
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

      const added = await commitAgentCapabilityAdd({
        db,
        assetService,
        deployer,
        skillIndex,
        tenantId: tenant.id,
        principalId: principal.id,
        assetId: row.assetId,
        handle: row.name,
        body,
      });
      return c.json(added);
    },
  );

  app.put(
    "/:definitionId",
    requireGrant(idResource("workflow-definition", "definitionId"), "update"),
    async (c) => {
      const body = UpdateAgentInstructionsInput(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid agent instructions: ${body.summary}`,
          }),
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

      const next = await commitLatestAgentAssetSnapshot({
        assetService,
        assetId: row.assetId,
        operation: "update instructions",
        prepare: (snapshot) =>
          Promise.resolve({
            workflowJson: withAgentSystemPrompt(snapshot, body.systemPrompt),
            message: `Update agent instructions for ${row.name}`,
            result: { name: body.name, systemPrompt: body.systemPrompt },
          }),
        write: async ({ workflowJson, message }) => {
          // Git first: the row updates below are what can still be retried
          // safely if they fail after this succeeds (see the catch below) —
          // the reverse order would leave a renamed row pointing at
          // instructions that were never actually written.
          await writeAndDeployAgentDefinition({
            assetService,
            deployer,
            tenantId: tenant.id,
            principalId: principal.id,
            assetId: row.assetId,
            handle: row.name,
            workflowJson,
            message,
          });
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
      } catch (err) {
        const refId = reportError(err, {
          operation: "agentDirectory.updateInstructions.rename",
          tenantId: tenant.id,
        });
        return c.json(
          makeErrorEnvelope({
            code: "partial_failure",
            userMessage:
              `The instructions saved, but renaming "${row.name}" to ` +
              `"${body.name}" failed — the agent now answers with the new ` +
              `instructions under its old name. Retry to finish the rename.`,
            refId,
          }),
          500,
        );
      }

      return c.json(next);
    },
  );

  // Its own verb, not `POST /capabilities` with an empty name: clearing
  // returns to the tenant's catalog default, a real reachable state.
  app.delete(
    "/:definitionId/capabilities/model",
    requireGrant(idResource("workflow-definition", "definitionId"), "update"),
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

      const cleared = await commitLatestAgentAssetSnapshot({
        assetService,
        assetId: row.assetId,
        operation: "clear model",
        prepare: async (snapshot) => {
          const workflowJson = withoutAgentModel(snapshot);
          const capabilities = readAgentCapabilities(workflowJson);
          // The snapshot carries the pins in its stanza — read them from
          // the commit being prepared, not a deleted side table.
          const skills = readPinnedSkillNames(workflowJson);
          return {
            workflowJson,
            message: `Clear ${row.name}'s model`,
            result: {
              toolPackagePins: capabilities.toolPackagePins,
              skills,
              model: capabilities.model,
            },
          };
        },
        write: async ({ workflowJson, message }) => {
          await assetService.populateAsset({
            assetId: row.assetId,
            ref: DEFAULT_ASSET_REF,
            principal: { kind: "hub" },
            tree: {
              files: agentDefinitionSourceTree({
                handle: row.name,
                workflowJson,
              }),
              message,
            },
          });
        },
      });
      return c.json(cleared);
    },
  );

  // Archive and restore. See docs/agent-definition-status-lifecycle.md for
  // the invariant this relies on and a known hole in the model.
  app.put(
    "/:definitionId/status",
    requireGrant(idResource("workflow-definition", "definitionId"), "update"),
    async (c) => {
      const body = UpdateDefinitionStatusInput(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid status: ${body.summary}`,
          }),
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

      await db
        .update(workflowDefinition)
        .set({ status: body.status, updatedAt: new Date() })
        .where(
          and(eq(workflowDefinition.id, definitionId), eq(workflowDefinition.tenantId, tenant.id)),
        );

      return c.json({ id: definitionId, status: body.status });
    },
  );

  app.put(
    "/:definitionId/skills",
    requireGrant(idResource("workflow-definition", "definitionId"), "update"),
    async (c) => {
      const body = UpdateAgentSkillsInput(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid skills list: ${body.summary}`,
          }),
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
          makeErrorEnvelope({
            code: "not_found",
            userMessage: `No agent definition "${definitionId}" in this workbench`,
          }),
          404,
        );
      }

      const assetId = row.assetId;
      const principal = c.get("principal");
      const updated = await commitLatestAgentAssetSnapshot({
        assetService,
        assetId,
        operation: "update skills",
        prepare: async (snapshot) => {
          const workflowJson = reindexPinnedSkills(
            snapshot,
            await skillIndex.resolve(tenant.id, principal.id, body.skills),
          );
          // The reindexed stanza is the pins: the commit above writes
          // the source of truth, so no post-write side-table sync.
          return {
            workflowJson,
            message: `Update agent skills for ${row.name}`,
            result: { skills: body.skills },
          };
        },
        write: async ({ workflowJson, message }) => {
          await writeAndDeployAgentDefinition({
            assetService,
            deployer,
            tenantId: tenant.id,
            principalId: principal.id,
            assetId,
            handle: row.name,
            workflowJson,
            message,
          });
        },
      });
      return c.json(updated);
    },
  );

  return app;
}
