// The workflow-authoring registry: an agent's in-tenant surface for
// publishing a workflow codebase as a native `kind:"workflow"` hub asset,
// republishing it, and reading it back. Every write is gated by two
// independent checks — own-tenant scoping (resolved from the DB row,
// mirroring `@corbits/skills`' `requireOwnTenant`) and an explicit
// grant-store authorization call (`asset:*`/create for a new asset,
// `asset:<id>`/write for a republish, `asset:<id>`/read for a source read)
// — and by `validateWorkflowSourceTree` before anything reaches
// `RepoStore`. Deploying an authored asset is deliberately NOT this
// package's job: deploy stays on `@intx/hub-api`'s existing source-based
// `POST .../workflows/deployments` route (`WorkflowDefinitionSource` +
// `entry`), which already installs, probes, gates, and freezes the
// definition. Building a second deploy path here would duplicate that
// gating, not strengthen it.
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
// exactly what the checks below do — before the already-authorized write
// is handed to the substrate as a hub-mediated commit.
//
// Head-sha reads (`expectedHeadSha`, `readSource`) go through `RepoStore`
// directly: `AssetService` exposes blob and directory reads pinned to a
// ref but never the sha that ref resolves to, and `listAssetBlobs` lists
// blobs only (no subtrees), so a full tree walk needs
// `RepoStore.openCommittedReads`. The repo id is the asset id under the
// `workflow` kind, exactly as `AssetService` composes it internally.
import { authorize } from "@intx/authz";
import type { ConditionRegistry, GrantStore } from "@intx/types/authz";
import {
  AssetServiceError,
  DEFAULT_ASSET_REF,
  type AssetService,
  type CommittedReads,
  type RepoStore,
} from "@intx/hub-sessions";
import type { DB } from "@intx/db";
import { asset as assetTable } from "@intx/db/schema";
import { and, eq } from "drizzle-orm";

import { WorkflowAuthorError } from "./errors";
import { validateWorkflowSourceTree } from "./source-tree";

const WORKFLOW_ASSET_KIND = "workflow";
const HUB_PRINCIPAL = { kind: "hub" } as const;

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

export type WorkflowSourceSnapshot = {
  readonly assetId: string;
  readonly name: string;
  readonly headSha: string;
  /** Repo-relative path -> UTF-8 file contents, every blob on the head
   * commit of `refs/heads/main`. */
  readonly files: Readonly<Record<string, string>>;
};

export type AuthorWorkflowInput = {
  readonly name: string;
  /** Repo-relative path -> file contents; see `validateWorkflowSourceTree`
   * for the rules a tree must satisfy before it is written. */
  readonly files: Record<string, string>;
  readonly message?: string;
};

export type RepublishWorkflowInput = {
  readonly files: Record<string, string>;
  readonly message?: string;
  /** When set, the write is refused with `conflict` (carrying the current
   * head) unless `refs/heads/main` still points here. */
  readonly expectedHeadSha?: string;
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
  readSource(
    caller: WorkflowAuthorCaller,
    assetId: string,
  ): Promise<WorkflowSourceSnapshot>;
};

export type WorkflowAuthorRepoReads = Pick<
  RepoStore,
  "resolveRef" | "openCommittedReads"
>;

export type CreateWorkflowAuthorRegistryDeps = {
  db: DB["db"];
  assetService: AssetService;
  repoStore: WorkflowAuthorRepoReads;
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
  action: "create" | "write" | "read",
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
      principal: HUB_PRINCIPAL,
      // `populateAsset` is additive (`RepoStore.writeTree` refuses a root
      // `clearPrefix`), so a republish overwrites the paths it names and
      // carries every other committed file forward; `readSource` shows the
      // caller the whole resulting tree.
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

async function resolveHeadSha(
  repoStore: WorkflowAuthorRepoReads,
  assetId: string,
): Promise<string> {
  const sha = await repoStore.resolveRef(
    HUB_PRINCIPAL,
    { kind: WORKFLOW_ASSET_KIND, id: assetId },
    DEFAULT_ASSET_REF,
  );
  if (sha === null) {
    throw new WorkflowAuthorError(
      "not_found",
      `workflow asset ${assetId} has no ${DEFAULT_ASSET_REF} yet`,
    );
  }
  return sha;
}

async function collectTree(
  reads: CommittedReads,
  dir: string,
  into: Record<string, string>,
): Promise<void> {
  const decoder = new TextDecoder();
  for (const entry of await reads.listDir(dir)) {
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.type === "tree") {
      await collectTree(reads, path, into);
    } else if (entry.type === "blob") {
      into[path] = decoder.decode(await reads.readBlobByOid(entry.oid));
    }
  }
}

export function createWorkflowAuthorRegistry(
  deps: CreateWorkflowAuthorRegistryDeps,
): WorkflowAuthorRegistry {
  const { db, assetService, repoStore } = deps;

  async function requireOwnWorkflowAsset(
    caller: WorkflowAuthorCaller,
    assetId: string,
  ): Promise<{ id: string; name: string }> {
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
    return { id: row.id, name: row.name };
  }

  return {
    async author(caller, input) {
      await requireAuthorized(deps, caller, "asset:*", "create");

      if (!WORKFLOW_ASSET_NAME_PATTERN.test(input.name)) {
        throw new WorkflowAuthorError(
          "invalid",
          `workflow name ${JSON.stringify(input.name)} must be lowercase-kebab (letters, digits, hyphens; no leading or trailing hyphen)`,
        );
      }
      const { files } = validateWorkflowSourceTree(input.files);

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
        { ...files },
        input.message ?? `Author ${input.name}`,
      );
      return { assetId: created.id, name: created.name, commitSha };
    },

    async republish(caller, assetId, input) {
      const row = await requireOwnWorkflowAsset(caller, assetId);
      const { files } = validateWorkflowSourceTree(input.files);

      await requireAuthorized(deps, caller, `asset:${assetId}`, "write");

      if (input.expectedHeadSha !== undefined) {
        const currentHeadSha = await resolveHeadSha(repoStore, assetId);
        if (currentHeadSha !== input.expectedHeadSha) {
          throw new WorkflowAuthorError(
            "conflict",
            `workflow asset ${assetId} moved: expected head ${input.expectedHeadSha} but ${DEFAULT_ASSET_REF} is at ${currentHeadSha}; re-read the source and retry`,
            { currentHeadSha },
          );
        }
      }

      const { commitSha } = await writeCodebase(
        assetService,
        assetId,
        { ...files },
        input.message ?? `Update ${row.name}`,
      );
      return { assetId, name: row.name, commitSha };
    },

    async readSource(caller, assetId) {
      const row = await requireOwnWorkflowAsset(caller, assetId);
      await requireAuthorized(deps, caller, `asset:${assetId}`, "read");

      const headSha = await resolveHeadSha(repoStore, assetId);
      const reads = await repoStore.openCommittedReads(
        HUB_PRINCIPAL,
        { kind: WORKFLOW_ASSET_KIND, id: assetId },
        DEFAULT_ASSET_REF,
      );
      if (reads === null) {
        throw new WorkflowAuthorError(
          "not_found",
          `workflow asset ${assetId} has no readable ${DEFAULT_ASSET_REF}`,
        );
      }
      const files: Record<string, string> = {};
      await collectTree(reads, "", files);
      return { assetId, name: row.name, headSha, files };
    },
  };
}
