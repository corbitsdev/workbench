// The workflow-authoring registry: an agent's in-tenant surface for
// publishing a workflow codebase as a native `kind:"workflow"` hub asset
// and republishing it. Every write is gated by two independent checks —
// own-tenant scoping (resolved from the DB row, mirroring
// `@corbits/skills`' `requireOwnTenant`) and an explicit grant-store
// authorization call (`asset:*`/create for a new asset, `asset:<id>`/write
// for a republish) — before anything reaches `RepoStore`. Deploying an
// authored asset is deliberately NOT this package's job: deploy stays on
// `@intx/hub-api`'s existing source-based `POST .../workflows/deployments`
// route (`WorkflowDefinitionSource` + `entry`), which already installs,
// probes, gates, and freezes the definition. Building a second deploy path
// here would duplicate that gating, not strengthen it.
//
// `populateAsset` is called with `principal: { kind: "hub" }`, the same
// principal `@corbits/skills`' `writeSkillMd` uses. This is deliberate,
// not a shortcut: `workflowKindHandler.workflowAuthorize`
// (`@intx/hub-sessions`) only recognizes three principal kinds for a
// workflow-asset write — `hub` (full access), `sidecar` (read-only,
// explicitly denied `writeTree`), and `user` (gated by git-token-shaped
// bearer claims this sidecar-authenticated caller never carries). There is
// no fourth "workflow-run" principal kind the substrate understands, so a
// real per-write authorization decision has to be made HERE, by this
// registry, against the grant store and the resolved caller identity —
// exactly what the two checks below do — before the already-authorized
// write is handed to the substrate as a hub-mediated commit.
import { authorize } from "@intx/authz";
import type { ConditionRegistry, GrantStore } from "@intx/types/authz";
import {
  AssetServiceError,
  DEFAULT_ASSET_REF,
  type AssetService,
} from "@intx/hub-sessions";
import type { DB } from "@intx/db";
import { asset as assetTable } from "@intx/db/schema";
import { and, eq } from "drizzle-orm";

const WORKFLOW_ASSET_KIND = "workflow";

export const WORKFLOW_ASSET_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type WorkflowAuthorCaller = {
  readonly tenantId: string;
  readonly principalId: string;
};

export type WorkflowAssetSummary = {
  readonly assetId: string;
  readonly name: string;
  readonly commitSha: string;
};

export type WorkflowAuthorErrorReason =
  "forbidden" | "not_found" | "conflict" | "invalid";

export class WorkflowAuthorError extends Error {
  readonly reason: WorkflowAuthorErrorReason;
  constructor(reason: WorkflowAuthorErrorReason, message: string) {
    super(message);
    this.name = "WorkflowAuthorError";
    this.reason = reason;
  }
}

export type AuthorWorkflowInput = {
  readonly name: string;
  /** Repo-relative path -> file contents. Must include a `package.json`
   * declaring a non-empty `interchange.workflow` entry; the substrate's
   * `workflowKindHandler.validatePush` rejects anything else, and that
   * rejection surfaces here as a `WorkflowAuthorError("invalid", ...)`,
   * never a 500. */
  readonly files: Record<string, string>;
  readonly message?: string;
};

export type RepublishWorkflowInput = {
  readonly files: Record<string, string>;
  readonly message?: string;
};

export type WorkflowAuthorRegistry = {
  author(
    caller: WorkflowAuthorCaller,
    input: AuthorWorkflowInput,
  ): Promise<WorkflowAssetSummary>;
  republish(
    caller: WorkflowAuthorCaller,
    assetId: string,
    input: RepublishWorkflowInput,
  ): Promise<WorkflowAssetSummary>;
};

export type CreateWorkflowAuthorRegistryDeps = {
  db: DB["db"];
  assetService: AssetService;
  grantStore: GrantStore;
  conditionRegistry: ConditionRegistry;
};

async function requireAuthorized(
  deps: Pick<
    CreateWorkflowAuthorRegistryDeps,
    "grantStore" | "conditionRegistry"
  >,
  caller: WorkflowAuthorCaller,
  resource: string,
  action: "create" | "write",
): Promise<void> {
  const verdict = await authorize(
    deps.grantStore,
    caller.principalId,
    caller.tenantId,
    resource,
    action,
    deps.conditionRegistry,
  );
  if (verdict.effect !== "allow") {
    throw new WorkflowAuthorError(
      "forbidden",
      `principal ${caller.principalId} is not granted "${action}" on "${resource}"`,
    );
  }
}

async function writeCodebase(
  assetService: AssetService,
  assetId: string,
  files: Record<string, string>,
  message: string,
): Promise<{ commitSha: string }> {
  try {
    return await assetService.populateAsset({
      assetId,
      ref: DEFAULT_ASSET_REF,
      principal: { kind: "hub" },
      tree: { files, message },
    });
  } catch (err) {
    if (err instanceof AssetServiceError) {
      throw new WorkflowAuthorError(
        err.reason === "not_found" ? "not_found" : "invalid",
        err.message,
      );
    }
    throw err;
  }
}

export function createWorkflowAuthorRegistry(
  deps: CreateWorkflowAuthorRegistryDeps,
): WorkflowAuthorRegistry {
  const { db, assetService } = deps;

  return {
    async author(caller, input) {
      await requireAuthorized(deps, caller, "asset:*", "create");

      if (!WORKFLOW_ASSET_NAME_PATTERN.test(input.name)) {
        throw new WorkflowAuthorError(
          "invalid",
          `workflow name ${JSON.stringify(input.name)} must be lowercase-kebab (letters, digits, hyphens; no leading or trailing hyphen)`,
        );
      }
      if (Object.keys(input.files).length === 0) {
        throw new WorkflowAuthorError(
          "invalid",
          "author_workflow requires at least one file",
        );
      }

      let created;
      try {
        created = await assetService.createAsset({
          tenantId: caller.tenantId,
          kind: WORKFLOW_ASSET_KIND,
          name: input.name,
          displayName: input.name,
          creatorPrincipalId: caller.principalId,
        });
      } catch (err) {
        if (err instanceof AssetServiceError) {
          throw new WorkflowAuthorError(
            err.reason === "duplicate_asset" ? "conflict" : "invalid",
            err.message,
          );
        }
        throw err;
      }

      const { commitSha } = await writeCodebase(
        assetService,
        created.id,
        input.files,
        input.message ?? `Author ${input.name}`,
      );
      return { assetId: created.id, name: created.name, commitSha };
    },

    async republish(caller, assetId, input) {
      // Own-tenant scoping is resolved from the DB row BEFORE the grant
      // check runs: an asset id from another tenant must read as
      // "not_found", never leak a 403 that confirms the id exists.
      const row = await db.query.asset.findFirst({
        where: and(
          eq(assetTable.id, assetId),
          eq(assetTable.tenantId, caller.tenantId),
          eq(assetTable.kind, WORKFLOW_ASSET_KIND),
        ),
      });
      if (row === undefined) {
        throw new WorkflowAuthorError(
          "not_found",
          `no workflow asset ${assetId} in this tenant`,
        );
      }
      if (Object.keys(input.files).length === 0) {
        throw new WorkflowAuthorError(
          "invalid",
          "republish_workflow requires at least one file",
        );
      }

      await requireAuthorized(deps, caller, `asset:${assetId}`, "write");

      const { commitSha } = await writeCodebase(
        assetService,
        assetId,
        input.files,
        input.message ?? `Update ${row.name}`,
      );
      return { assetId, name: row.name, commitSha };
    },
  };
}
