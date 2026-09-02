// The workflow-authoring registry: an agent's in-tenant surface for
// publishing a workflow codebase as a native `kind:"workflow"` hub asset,
// republishing it, and reading it back. Every write is gated by two
// independent checks — own-tenant scoping (resolved from the DB row,
// mirroring `@corbits/skills`' `requireOwnTenant`) and an explicit
// grant-store authorization call (`asset:*`/create for a new asset,
// `asset:<id>`/write for a republish, `asset:<id>`/read for a source read)
// — and by `validateWorkflowSourceTree` before anything reaches
// `RepoStore`. `deploy` (CL-7361) is a run-authenticated mirror of
// `@intx/hub-api`'s existing source-based `POST .../workflows/deployments`
// route: it checks `workflow:*`/`create` itself, then calls a
// `WorkflowDeployer` apps/hub injects that wraps the SAME
// `sessionService.deployWorkflowFromSource` call the native route makes
// (`withDeploySourceRecording` included) with inference sources resolved
// server-side from the tenant's catalog, never supplied by the caller.
// No install/probe/gate/freeze logic is reimplemented here.
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
import { type } from "arktype";
import { PackageJSON } from "@intx/types/package-json";

import { WorkflowAuthorError } from "./errors";
import {
  PACKAGE_JSON_PATH,
  validateWorkflowSourceTree,
} from "./source-tree";

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

export type DeployWorkflowInput = {
  readonly commitSha: string;
  readonly entry: string;
};

export type WorkflowDeployResult = {
  readonly deploymentId: string;
  readonly definitionAssetId: string;
  readonly status: "deployed" | "pending";
};

export type WorkflowDeployPreviewResult = {
  readonly commitSha: string;
  readonly entry: string;
  /** Every repo-relative file path in the committed tree at `commitSha`. */
  readonly files: readonly string[];
  /** The `toolPackagePins` an inert `export default {...}` entry declares;
   * empty when the entry isn't a plain object literal (a folded/built
   * workflow — pins aren't statically knowable there without execution). */
  readonly toolPackagePins: readonly { readonly name: string; readonly version: string }[];
  readonly packageName: string;
};

/**
 * The apps/hub-supplied seam onto the same operation the native
 * `POST /workflows/deployments` route drives (`sessionService.
 * deployWorkflowFromSource`, wrapped by `withDeploySourceRecording`), with
 * inference sources resolved server-side from the tenant's catalog. Thrown
 * failures are `WorkflowAuthorError`s with a reason this registry passes
 * straight through: `not_found` (asset/commit missing), `invalid`
 * (rejected package/definition), `unavailable` (sidecar unreachable).
 *
 * CL-7362: this seam carries no `previewDeploy` — the preview
 * (`registry.previewDeploy` below) never touches `sessionService` at all,
 * so it cannot freeze anything even by accident. It is a static read of
 * the already-committed source through `RepoStore` alone.
 */
export type WorkflowDeployer = {
  deploy(params: {
    tenantId: string;
    principalId: string;
    assetId: string;
    assetName: string;
    commitSha: string;
    entry: string;
  }): Promise<WorkflowDeployResult>;
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
  deploy(
    caller: WorkflowAuthorCaller,
    assetId: string,
    input: DeployWorkflowInput,
  ): Promise<WorkflowDeployResult>;
  previewDeploy(
    caller: WorkflowAuthorCaller,
    assetId: string,
    input: DeployWorkflowInput,
  ): Promise<WorkflowDeployPreviewResult>;
};

export type WorkflowAuthorRepoReads = Pick<
  RepoStore,
  "resolveRef" | "openCommittedReads" | "openCommittedReadsAtCommit"
>;

export type CreateWorkflowAuthorRegistryDeps = {
  db: DB["db"];
  assetService: AssetService;
  repoStore: WorkflowAuthorRepoReads;
  grantStore: GrantStore;
  conditionRegistry: ConditionRegistry;
  deployer: WorkflowDeployer;
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

/**
 * CL-7362: a best-effort, read-only render of an inert `export default
 * {...}` object literal in an entry module — the shape a folded/single-step
 * workflow package's entry commonly takes. Deliberately NOT a JS parser or
 * evaluator (the source is untrusted agent output and must never be
 * executed): strips the `export default` prefix and a trailing `;`, then
 * accepts the remainder only if `JSON.parse` on it (after quoting bare
 * object keys, the one common non-JSON literal shape) succeeds. Any import,
 * function call, or other executable construct fails this and the caller
 * falls back to listing files only.
 */
function tryReadInertDefaultExport(source: string): unknown {
  const trimmed = source.trim();
  const match = /^export\s+default\s+([\s\S]*?);?\s*$/.exec(trimmed);
  if (match === null || match[1] === undefined) return undefined;
  const quotedKeys = match[1].replace(
    /([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g,
    '$1"$2"$3',
  );
  try {
    return JSON.parse(quotedKeys);
  } catch {
    return undefined;
  }
}

function extractToolPackagePins(
  literal: unknown,
): readonly { readonly name: string; readonly version: string }[] {
  if (literal === undefined || literal === null || typeof literal !== "object") {
    return [];
  }
  const pins = (literal as Record<string, unknown>).toolPackagePins;
  if (!Array.isArray(pins)) return [];
  const out: { readonly name: string; readonly version: string }[] = [];
  for (const pin of pins) {
    if (
      pin !== null &&
      typeof pin === "object" &&
      typeof (pin as Record<string, unknown>).name === "string" &&
      typeof (pin as Record<string, unknown>).version === "string"
    ) {
      out.push({
        name: (pin as { name: string }).name,
        version: (pin as { version: string }).version,
      });
    }
  }
  return out;
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

      // Resolve the head sha and open the tree read from the SAME ref
      // resolution so a concurrent republish landing between two separate
      // calls can never produce a headSha/files mismatch.
      const headSha = await resolveHeadSha(repoStore, assetId);
      const reads = await repoStore.openCommittedReadsAtCommit(
        HUB_PRINCIPAL,
        { kind: WORKFLOW_ASSET_KIND, id: assetId },
        headSha,
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

    async deploy(caller, assetId, input) {
      // Own-tenant scoping resolved BEFORE the grant check, same as every
      // other write here: an asset id from another tenant reads as
      // not_found, never a 403 confirming the id exists.
      const row = await requireOwnWorkflowAsset(caller, assetId);
      await requireAuthorized(deps, caller, "workflow:*", "create");

      return deps.deployer.deploy({
        tenantId: caller.tenantId,
        principalId: caller.principalId,
        assetId,
        assetName: row.name,
        commitSha: input.commitSha,
        entry: input.entry,
      });
    },

    async previewDeploy(caller, assetId, input) {
      // Own-tenant scoping and the same `workflow:*`/create authorization
      // as `deploy`: a preview shows exactly what `deploy` would name.
      const row = await requireOwnWorkflowAsset(caller, assetId);
      await requireAuthorized(deps, caller, "workflow:*", "create");

      // A STATIC read of the already-committed source at `commitSha` —
      // never install/probe/gate/freeze, so this truly cannot deploy
      // anything. See `WorkflowDeployer`'s doc comment.
      const reads = await repoStore.openCommittedReadsAtCommit(
        HUB_PRINCIPAL,
        { kind: WORKFLOW_ASSET_KIND, id: assetId },
        input.commitSha,
      );
      if (reads === null) {
        throw new WorkflowAuthorError(
          "not_found",
          `workflow asset ${assetId} has no commit ${input.commitSha}`,
        );
      }
      const files: Record<string, string> = {};
      await collectTree(reads, "", files);
      if (!(input.entry in files)) {
        throw new WorkflowAuthorError(
          "invalid",
          `entry ${JSON.stringify(input.entry)} names no file in commit ${input.commitSha}`,
        );
      }
      const manifestSource = files[PACKAGE_JSON_PATH];
      if (manifestSource === undefined) {
        throw new WorkflowAuthorError(
          "invalid",
          `commit ${input.commitSha} has no top-level ${PACKAGE_JSON_PATH}`,
        );
      }
      let manifestJson: unknown;
      try {
        manifestJson = JSON.parse(manifestSource);
      } catch (cause) {
        throw new WorkflowAuthorError(
          "invalid",
          `${PACKAGE_JSON_PATH} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      const manifest = PackageJSON(manifestJson);
      if (manifest instanceof type.errors) {
        throw new WorkflowAuthorError(
          "invalid",
          `${PACKAGE_JSON_PATH} failed validation: ${manifest.summary}`,
        );
      }
      const packageName = manifest.name;
      const entrySource = files[input.entry] ?? "";
      const inertLiteral = tryReadInertDefaultExport(entrySource);
      const toolPackagePins = extractToolPackagePins(inertLiteral);

      return {
        commitSha: input.commitSha,
        entry: input.entry,
        files: Object.keys(files),
        toolPackagePins,
        packageName,
      };
    },
  };
}
