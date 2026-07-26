import { type } from "arktype";
import { createHash } from "node:crypto";
import { normalize, sep } from "node:path";
import nodefs from "node:fs";
import git from "isomorphic-git";
import JSZip from "jszip";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { schema as intxSchema, getAncestorChain } from "@intx/db";
import { getLogger } from "@intx/log";
import type { HubDb } from "../db";
import { skillAccess } from "../db/schema";
import type { AssetService, RepoStore } from "@workbench/hub-sessions";
import {
  AssetServiceError,
  SKILL_DRAFT_ENTRYPOINT,
  SKILL_DRAFT_META_PATH,
  SKILL_DRAFT_PREFIX,
} from "@workbench/hub-sessions";
import type { UserContext } from "../lib/user-context";
import { isSlugShaped, toAssetName } from "@workbench/shared";

export { toAssetName } from "@workbench/shared";

const log = getLogger(["skill-library"]);

export const MAX_SKILL_BUNDLE_BYTES = 20 * 1024 * 1024;
export const MAX_SKILL_FILE_COUNT = 200;
export const MAX_PROMPT_FILE_BYTES = 256 * 1024;

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".css",
  ".html",
]);

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".sh",
  ".bash",
]);

const JUNK_PATHS = new Set([".DS_Store", "Thumbs.db"]);

type JSZipEntryWithMetadata = JSZip.JSZipObject & {
  _data?: { uncompressedSize?: number };
};

export type SkillCreateSource = "paste" | "file" | "folder" | "zip";

export type SkillBundleFileInput = {
  path: string;
  content: Buffer;
  mimeType?: string;
};

export type SkillBundleManifestFile = {
  path: string;
  size: number;
  mimeType: string;
  sha256: string;
  promptReadable: boolean;
  executableLike: boolean;
};

export type SkillBundleManifest = {
  files: SkillBundleManifestFile[];
  entrypointPath: string;
  totalSize: number;
  checksum: string;
};

export const skillAccessScopeSchema = type("'private' | 'tenant'");
export type SkillAccessScope = typeof skillAccessScopeSchema.infer;

export const skillItemSchema = type({
  id: "string",
  name: "string",
  displayName: "string | null",
  description: "string | null",
  createdAt: "string",
  updatedAt: "string",
  scope: skillAccessScopeSchema,
  accessTenantId: "string",
  ownerUserId: "string | null",
  ownerName: "string | null",
});
export type SkillItem = typeof skillItemSchema.infer;

/**
 * Pure visibility rule for a skill asset given the viewer's tenant ancestor
 * chain and user id. A skill is visible when its tenant is somewhere in the
 * viewer's chain (the walk-up share target) and either it is tenant-scoped (or
 * a legacy row with no scope) or it is private and owned by the viewer.
 */
export function isSkillVisible(
  row: {
    assetTenantId: string;
    scope: SkillAccessScope | null;
    ownerUserId: string | null;
  },
  viewer: { ancestorTenantIds: string[]; userId: string },
): boolean {
  if (!viewer.ancestorTenantIds.includes(row.assetTenantId)) return false;
  const scope = row.scope ?? "tenant";
  if (scope === "tenant") return true;
  return row.ownerUserId === viewer.userId;
}

export class SkillLibraryError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "SkillLibraryError";
  }
}

const SKILL_BUNDLE_REF = "refs/heads/main";

function extension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot).toLowerCase() : "";
}

function normalizeBundlePath(path: string): string | null {
  const unixPath = path.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!unixPath || unixPath.includes("\0")) return null;
  if (
    unixPath.startsWith("../") ||
    unixPath.includes("/../") ||
    unixPath === ".."
  )
    return null;
  const normalized = normalize(unixPath).replaceAll(sep, "/");
  if (
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    normalized === ".."
  )
    return null;
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".." || part === "")) return null;
  if (parts[0] === "__MACOSX") return null;
  if (JUNK_PATHS.has(parts.at(-1) ?? "")) return null;
  return normalized;
}

function isPromptReadable(
  path: string,
  mimeType: string,
  size: number,
): boolean {
  if (size > MAX_PROMPT_FILE_BYTES) return false;
  if (mimeType.startsWith("text/")) return true;
  if (mimeType === "application/json") return true;
  return TEXT_EXTENSIONS.has(extension(path));
}

function isExecutableLike(path: string): boolean {
  return CODE_EXTENSIONS.has(extension(path));
}

function chooseEntrypoint(paths: string[]): string {
  const exact = paths.find((path) => path === "SKILL.md");
  if (exact) return exact;
  const nested = paths.find((path) => path.endsWith("/SKILL.md"));
  if (nested) return nested;
  const markdown = paths.find((path) => path.toLowerCase().endsWith(".md"));
  if (markdown) return markdown;
  throw new SkillLibraryError(
    "Skill bundle must include SKILL.md or at least one markdown file",
  );
}

export type SkillBundle = {
  manifest: SkillBundleManifest;
  files: { path: string; content: Buffer; mimeType: string }[];
};

export function buildSkillBundle(files: SkillBundleFileInput[]): SkillBundle {
  if (files.length === 0)
    throw new SkillLibraryError("Skill bundle must include at least one file");
  if (files.length > MAX_SKILL_FILE_COUNT) {
    throw new SkillLibraryError(
      `Skill bundle exceeds the ${MAX_SKILL_FILE_COUNT} file limit`,
      413,
    );
  }

  const normalizedFiles: SkillBundleFileInput[] = [];
  const seen = new Set<string>();
  let totalSize = 0;

  for (const file of files) {
    const normalizedPath = normalizeBundlePath(file.path);
    if (!normalizedPath)
      throw new SkillLibraryError(`Unsafe skill bundle path: ${file.path}`);
    if (seen.has(normalizedPath))
      throw new SkillLibraryError(
        `Duplicate skill bundle path: ${normalizedPath}`,
      );
    seen.add(normalizedPath);
    totalSize += file.content.byteLength;
    if (totalSize > MAX_SKILL_BUNDLE_BYTES) {
      throw new SkillLibraryError(
        `Skill bundle exceeds the ${MAX_SKILL_BUNDLE_BYTES} byte limit`,
        413,
      );
    }
    if (file.content.byteLength === 0) continue;
    normalizedFiles.push({ ...file, path: normalizedPath });
  }

  if (normalizedFiles.length === 0)
    throw new SkillLibraryError("Skill bundle files are empty");

  const entrypointPath = chooseEntrypoint(
    normalizedFiles.map((file) => file.path),
  );
  const manifestFiles = normalizedFiles
    .map((file) => {
      const mimeType = file.mimeType || "application/octet-stream";
      return {
        path: file.path,
        size: file.content.byteLength,
        mimeType,
        sha256: createHash("sha256").update(file.content).digest("hex"),
        promptReadable: isPromptReadable(
          file.path,
          mimeType,
          file.content.byteLength,
        ),
        executableLike: isExecutableLike(file.path),
      } satisfies SkillBundleManifestFile;
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  const checksum = createHash("sha256")
    .update(
      JSON.stringify(
        manifestFiles.map(({ path, sha256 }) => ({ path, sha256 })),
      ),
    )
    .digest("hex");

  return {
    manifest: { files: manifestFiles, entrypointPath, totalSize, checksum },
    files: normalizedFiles.map((file) => ({
      path: file.path,
      content: Buffer.from(file.content),
      mimeType: file.mimeType || "application/octet-stream",
    })),
  };
}

export async function filesFromZip(
  content: Buffer,
): Promise<SkillBundleFileInput[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(content);
  } catch {
    throw new SkillLibraryError("Invalid zip archive");
  }

  const files: SkillBundleFileInput[] = [];
  let totalSize = 0;
  for (const rawEntry of Object.values(zip.files)) {
    const entry = rawEntry as JSZipEntryWithMetadata;
    if (entry.dir) continue;
    if (files.length >= MAX_SKILL_FILE_COUNT) {
      throw new SkillLibraryError(
        `Skill bundle exceeds the ${MAX_SKILL_FILE_COUNT} file limit`,
        413,
      );
    }
    const declaredSize = entry._data?.uncompressedSize;
    if (
      declaredSize !== undefined &&
      totalSize + declaredSize > MAX_SKILL_BUNDLE_BYTES
    ) {
      throw new SkillLibraryError(
        `Skill bundle exceeds the ${MAX_SKILL_BUNDLE_BYTES} byte limit`,
        413,
      );
    }
    const fileContent = Buffer.from(await entry.async("uint8array"));
    totalSize += fileContent.byteLength;
    if (totalSize > MAX_SKILL_BUNDLE_BYTES) {
      throw new SkillLibraryError(
        `Skill bundle exceeds the ${MAX_SKILL_BUNDLE_BYTES} byte limit`,
        413,
      );
    }
    files.push({
      path: entry.name,
      content: fileContent,
      mimeType: "application/octet-stream",
    });
  }
  return files;
}

function bundlePrefixFromEntrypoint(entrypointPath: string): string {
  const slashIdx = entrypointPath.lastIndexOf("/");
  return slashIdx >= 0 ? entrypointPath.slice(0, slashIdx + 1) : "";
}

function stripBundlePrefix(filePath: string, bundlePrefix: string): string {
  return filePath.startsWith(bundlePrefix)
    ? filePath.slice(bundlePrefix.length)
    : filePath;
}

/**
 * Builds the TreeContent files record for the Interchange asset substrate.
 * All bundle files are placed under `<assetName>/` and the entrypoint SKILL.md
 * receives synthesized YAML frontmatter so the skillKindHandler accepts the push.
 */
export function buildSkillTree(
  assetName: string,
  description: string | null | undefined,
  bundle: SkillBundleManifest,
  fileContents: Map<string, Buffer>,
): Record<string, Uint8Array> {
  const bundlePrefix = bundlePrefixFromEntrypoint(bundle.entrypointPath);

  const files: Record<string, Uint8Array> = {};
  for (const file of bundle.files) {
    const content = fileContents.get(file.path);
    if (!content)
      throw new Error(`Missing content for bundle file: ${file.path}`);
    const treePath = `${assetName}/${stripBundlePrefix(file.path, bundlePrefix)}`;
    files[treePath] = content;
  }

  const entrypointTreePath = `${assetName}/SKILL.md`;
  const originalEntrypointKey = `${assetName}/${stripBundlePrefix(bundle.entrypointPath, bundlePrefix)}`;
  const existingContent =
    files[entrypointTreePath] ?? files[originalEntrypointKey];
  // Remove the original entrypoint file if it mapped to a different tree path
  // so we don't end up with both `assetName/docs/SKILL.md` and `assetName/SKILL.md`.
  if (originalEntrypointKey !== entrypointTreePath) {
    delete files[originalEntrypointKey];
  }
  const bodyText = existingContent
    ? new TextDecoder().decode(existingContent)
    : "";
  const strippedBody = bodyText.replace(/^---[\s\S]*?---\n?/, "");
  const frontmatter = `---\nname: ${assetName}\ndescription: "${(description ?? "Skill").replace(/"/g, '\\"')}"\n---\n`;
  files[entrypointTreePath] = new TextEncoder().encode(
    frontmatter + strippedBody,
  );

  return files;
}

// An actor managing a skill: the working tenant (for the visibility chain), the
// stable user id (for ownership), and the per-tenant principal (legacy fallback).
export type SkillActor = {
  tenantId: string;
  userId: string;
  principalId: string;
};

/**
 * Pure ownership rule for managing (delete/update/restore) a skill. New skills
 * carry an access row, so ownership is the stable user id; legacy rows with no
 * access entry fall back to the original creator principal. Keyed on user id —
 * not principal id — because principals are per-tenant and a shared skill is
 * managed from a tenant whose principal differs from the creator's.
 */
export function canManageSkill(
  row: { ownerUserId: string | null; creatorPrincipalId: string | null },
  actor: { userId: string; principalId: string },
): boolean {
  if (row.ownerUserId !== null) return row.ownerUserId === actor.userId;
  return (
    row.creatorPrincipalId !== null &&
    row.creatorPrincipalId === actor.principalId
  );
}

type ManageableSkill = {
  id: string;
  name: string;
  displayName: string | null;
  tenantId: string;
  creatorPrincipalId: string | null;
  createdAt: Date;
  updatedAt: Date;
  scope: SkillAccessScope | null;
  ownerUserId: string | null;
};

/**
 * Loads a skill the actor may manage (delete/update/restore). Resolves the asset
 * across the actor's tenant ancestor chain — not just the working tenant, since a
 * shared skill lives in a parent tenant — then asserts ownership by stable user id
 * (the access row), falling back to the creator principal for legacy rows with no
 * access entry. Throws 404 if not visible, 403 if visible but not owned.
 */
async function loadManageableSkill(
  db: HubDb,
  actor: SkillActor,
  assetId: string,
): Promise<ManageableSkill> {
  const ancestorTenantIds = await getAncestorChain(db as never, actor.tenantId);
  const rows = await db
    .select({
      id: intxSchema.asset.id,
      name: intxSchema.asset.name,
      displayName: intxSchema.asset.displayName,
      tenantId: intxSchema.asset.tenantId,
      creatorPrincipalId: intxSchema.asset.creatorPrincipalId,
      createdAt: intxSchema.asset.createdAt,
      updatedAt: intxSchema.asset.updatedAt,
      scope: skillAccess.scope,
      ownerUserId: skillAccess.ownerUserId,
    })
    .from(intxSchema.asset)
    .leftJoin(skillAccess, eq(skillAccess.assetId, intxSchema.asset.id))
    .where(
      and(eq(intxSchema.asset.id, assetId), eq(intxSchema.asset.kind, "skill")),
    )
    .limit(1);
  const row = rows[0];
  if (
    !row ||
    !isSkillVisible(
      {
        assetTenantId: row.tenantId,
        scope: row.scope,
        ownerUserId: row.ownerUserId,
      },
      { ancestorTenantIds, userId: actor.userId },
    )
  ) {
    throw new SkillLibraryError("Skill not found", 404);
  }
  if (!canManageSkill(row, actor)) {
    throw new SkillLibraryError(
      "You do not have permission to modify this skill",
      403,
    );
  }
  return row;
}

export async function deleteSkill(
  db: HubDb,
  repoStore: RepoStore,
  actor: SkillActor,
  assetId: string,
): Promise<void> {
  await loadManageableSkill(db, actor, assetId);
  // Delete DB row first — cascade removes agent_asset rows. Then remove the
  // git repo from disk. If the fs.rm fails we log and continue; the row is
  // already gone so the skill is invisible regardless.
  await db.delete(intxSchema.asset).where(eq(intxSchema.asset.id, assetId));
  // skill_access has no FK to asset (asset is @intx-owned), so clear it here.
  await db.delete(skillAccess).where(eq(skillAccess.assetId, assetId));
  const repoDir = repoStore.getRepoDir({ kind: "skill", id: assetId });
  await nodefs.promises
    .rm(repoDir, { recursive: true, force: true })
    .catch((err) => {
      log.error("Failed to remove skill git repo after delete", {
        assetId,
        repoDir,
        error: String(err),
      });
    });
}

export type SkillViewer = { tenantId: string; userId: string };

type SkillRow = {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
  tenantId: string;
  createdAt: Date;
  updatedAt: Date;
  scope: SkillAccessScope | null;
  ownerUserId: string | null;
  ownerName: string | null;
};

function toSkillItem(row: SkillRow): SkillItem {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName ?? null,
    description: row.description ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    scope: row.scope ?? "tenant",
    accessTenantId: row.tenantId,
    ownerUserId: row.ownerUserId ?? null,
    ownerName: row.ownerName ?? null,
  };
}

const skillRowColumns = {
  id: intxSchema.asset.id,
  name: intxSchema.asset.name,
  displayName: intxSchema.asset.displayName,
  description: skillAccess.description,
  tenantId: intxSchema.asset.tenantId,
  createdAt: intxSchema.asset.createdAt,
  updatedAt: intxSchema.asset.updatedAt,
  scope: skillAccess.scope,
  ownerUserId: skillAccess.ownerUserId,
  ownerName: intxSchema.user.name,
};

export async function listSkills(
  db: HubDb,
  viewer: SkillViewer,
): Promise<SkillItem[]> {
  const ancestorTenantIds = await getAncestorChain(
    db as never,
    viewer.tenantId,
  );
  const rows = await db
    .select(skillRowColumns)
    .from(intxSchema.asset)
    .leftJoin(skillAccess, eq(skillAccess.assetId, intxSchema.asset.id))
    .leftJoin(intxSchema.user, eq(intxSchema.user.id, skillAccess.ownerUserId))
    .where(
      and(
        inArray(intxSchema.asset.tenantId, ancestorTenantIds),
        eq(intxSchema.asset.kind, "skill"),
      ),
    )
    .orderBy(asc(intxSchema.asset.createdAt));

  return rows
    .filter((row) =>
      isSkillVisible(
        {
          assetTenantId: row.tenantId,
          scope: row.scope,
          ownerUserId: row.ownerUserId,
        },
        { ancestorTenantIds, userId: viewer.userId },
      ),
    )
    .map(toSkillItem);
}

export type SkillShareTarget = { tenantId: string; name: string };

/**
 * The tenants a user may share a skill with, walking up the ancestor chain from
 * the working tenant and keeping only those the user is an active member of,
 * closest first. The "Just Me" (private) option is added client-side.
 */
export async function listShareTargets(
  db: HubDb,
  userId: string,
  tenantId: string,
): Promise<SkillShareTarget[]> {
  const chain = await getAncestorChain(db as never, tenantId);
  const rows = await db
    .select({ id: intxSchema.tenant.id, name: intxSchema.tenant.name })
    .from(intxSchema.principal)
    .innerJoin(
      intxSchema.tenant,
      eq(intxSchema.tenant.id, intxSchema.principal.tenantId),
    )
    .where(
      and(
        eq(intxSchema.principal.refId, userId),
        eq(intxSchema.principal.kind, "user"),
        eq(intxSchema.principal.status, "active"),
        inArray(intxSchema.principal.tenantId, chain),
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row.name]));
  return chain
    .filter((id) => byId.has(id))
    .map((id) => ({ tenantId: id, name: byId.get(id) ?? id }));
}

export async function getSkillAsset(
  db: HubDb,
  viewer: SkillViewer,
  assetId: string,
): Promise<SkillItem | null> {
  const ancestorTenantIds = await getAncestorChain(
    db as never,
    viewer.tenantId,
  );
  const rows = await db
    .select(skillRowColumns)
    .from(intxSchema.asset)
    .leftJoin(skillAccess, eq(skillAccess.assetId, intxSchema.asset.id))
    .leftJoin(intxSchema.user, eq(intxSchema.user.id, skillAccess.ownerUserId))
    .where(
      and(eq(intxSchema.asset.id, assetId), eq(intxSchema.asset.kind, "skill")),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (
    !isSkillVisible(
      {
        assetTenantId: row.tenantId,
        scope: row.scope,
        ownerUserId: row.ownerUserId,
      },
      { ancestorTenantIds, userId: viewer.userId },
    )
  ) {
    return null;
  }
  return toSkillItem(row);
}

async function readAssetFile(
  repoStore: RepoStore,
  assetId: string,
  treePath: string,
  fs: typeof nodefs = nodefs,
): Promise<Buffer | null> {
  const dir = repoStore.getRepoDir({ kind: "skill", id: assetId });
  try {
    const { blob } = await git.readBlob({
      fs,
      dir,
      oid: SKILL_BUNDLE_REF,
      filepath: treePath,
    });
    return Buffer.from(blob);
  } catch (err) {
    // Distinguish "file not in tree" (NotFoundError) from storage failures.
    const name = err instanceof Error ? err.name : "";
    if (name === "NotFoundError" || name === "TreeOrBlobNotFoundError")
      return null;
    log.error("Unexpected error reading asset file", {
      assetId,
      treePath,
      error: String(err),
    });
    return null;
  }
}

/**
 * Reads SKILL.md from the asset git repo for prompt injection (e.g. A/B comparison).
 * `assetName` is the kebab name stored in `asset.name`.
 */
export async function readSkillPrompt(
  repoStore: RepoStore,
  assetId: string,
  assetName: string,
): Promise<string | null> {
  const content = await readAssetFile(
    repoStore,
    assetId,
    `${assetName}/SKILL.md`,
  );
  return content ? content.toString("utf8") : null;
}

export async function getSkillContent(
  repoStore: RepoStore,
  assetId: string,
  assetName: string,
  fs: typeof nodefs = nodefs,
): Promise<{ path: string; content?: string }[]> {
  const dir = repoStore.getRepoDir({ kind: "skill", id: assetId });
  const prefix = `${assetName}/`;

  try {
    const entries = await git.walk({
      fs,
      dir,
      trees: [git.TREE({ ref: SKILL_BUNDLE_REF })],
      map: async (filepath, [entry]) => {
        if (!entry) return null;
        if ((await entry.type()) !== "blob") return undefined;
        if (!filepath.startsWith(prefix)) return undefined;
        const relativePath = filepath.slice(prefix.length);
        if (!relativePath) return null;
        const blob = await entry.content();
        let content: string | undefined;
        if (blob) {
          try {
            content = new TextDecoder("utf-8", { fatal: true }).decode(blob);
          } catch {
            // binary file — omit content
          }
        }
        // Strip the Interchange-injected YAML frontmatter from the entrypoint
        // file — it is an internal contract with the skillKindHandler, not user content.
        const displayContent =
          relativePath === "SKILL.md" && content
            ? content.replace(/^---[\s\S]*?---\n?/, "")
            : content;
        return { path: relativePath, content: displayContent };
      },
    });
    return (
      entries.filter(Boolean) as { path: string; content?: string }[]
    ).sort((a, b) => a.path.localeCompare(b.path));
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name !== "NotFoundError" && name !== "TreeOrBlobNotFoundError") {
      log.error("Unexpected error reading skill content", {
        assetId,
        error: String(err),
      });
    }
    return [];
  }
}

export const skillVersionSchema = type({
  sha: "string",
  shortSha: "string",
  version: "number",
  message: "string",
  authorName: "string",
  createdAt: "string",
});
export type SkillVersion = typeof skillVersionSchema.infer;

type RawCommit = {
  oid: string;
  commit: { message: string; author: { name: string; timestamp: number } };
};

// Interchange's storage-isogit lays down a genesis commit with this message
// (containing only .gitignore) when it inits an asset repo, before any content
// is written. It's platform bookkeeping, not a skill version, so it's excluded
// from history — otherwise every freshly created skill shows a spurious v1.
const REPO_INIT_COMMIT_MESSAGE = "Initialize repository";

export function excludeRepoInitCommit(commits: RawCommit[]): RawCommit[] {
  return commits.filter(
    (entry) => entry.commit.message.trim() !== REPO_INIT_COMMIT_MESSAGE,
  );
}

/**
 * Assigns sequential version numbers to git log output, which arrives
 * newest-first: the oldest commit is v1 and the newest gets the highest number.
 */
export function toVersionEntries(commits: RawCommit[]): SkillVersion[] {
  const total = commits.length;
  return commits.map((entry, index) => ({
    sha: entry.oid,
    shortSha: entry.oid.slice(0, 7),
    version: total - index,
    message: entry.commit.message.trim(),
    authorName: entry.commit.author.name,
    createdAt: new Date(entry.commit.author.timestamp * 1000).toISOString(),
  }));
}

export const DEFAULT_VERSION_PAGE_SIZE = 20;
export const MAX_VERSION_PAGE_SIZE = 100;

export type SkillVersionPage = { versions: SkillVersion[]; total: number };

// Full, absolutely-numbered version list (v1 = oldest). Kept private so callers
// that need the whole history (pagination, sha validation) share one git walk.
async function readAllVersions(
  repoStore: RepoStore,
  assetId: string,
  fs: typeof nodefs,
): Promise<SkillVersion[]> {
  const dir = repoStore.getRepoDir({ kind: "skill", id: assetId });
  try {
    const commits = await git.log({ fs, dir, ref: SKILL_BUNDLE_REF });
    return toVersionEntries(excludeRepoInitCommit(commits as RawCommit[]));
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name !== "NotFoundError" && name !== "TreeOrBlobNotFoundError") {
      log.error("Unexpected error reading skill versions", {
        assetId,
        error: String(err),
      });
    }
    return [];
  }
}

/**
 * Returns a page of version history (newest first) plus the total count, so the
 * UI can bound how much it renders. Version numbers stay absolute (v1 = oldest)
 * regardless of the page window.
 */
export async function listSkillVersions(
  repoStore: RepoStore,
  assetId: string,
  opts: { limit?: number; offset?: number } = {},
  fs: typeof nodefs = nodefs,
): Promise<SkillVersionPage> {
  const all = await readAllVersions(repoStore, assetId, fs);
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(
    MAX_VERSION_PAGE_SIZE,
    Math.max(1, opts.limit ?? DEFAULT_VERSION_PAGE_SIZE),
  );
  return { versions: all.slice(offset, offset + limit), total: all.length };
}

/**
 * Restores a skill to a prior commit by reading that commit's tree and writing
 * it back to refs/heads/main as a new commit. Owner-only, matching delete.
 */
export async function restoreSkillVersion(
  assetService: AssetService,
  db: HubDb,
  repoStore: RepoStore,
  actor: SkillActor,
  assetId: string,
  sha: string,
  fs: typeof nodefs = nodefs,
): Promise<SkillItem> {
  const existing = await loadManageableSkill(db, actor, assetId);

  // Only restore a sha that is actually in this skill's version history —
  // never an arbitrary (e.g. dangling) commit object the caller names. Validate
  // against the full history, not a single page.
  const history = await readAllVersions(repoStore, assetId, fs);
  if (!history.some((version) => version.sha === sha)) {
    throw new SkillLibraryError("Version not found", 404);
  }

  const dir = repoStore.getRepoDir({ kind: "skill", id: assetId });
  const prefix = `${existing.name}/`;
  const files: Record<string, Uint8Array> = {};
  try {
    await git.walk({
      fs,
      dir,
      trees: [git.TREE({ ref: sha })],
      map: async (filepath, [entry]) => {
        if (!entry) return null;
        if ((await entry.type()) !== "blob") return undefined;
        if (!filepath.startsWith(prefix)) return undefined;
        const blob = await entry.content();
        if (blob) files[filepath] = blob;
        return filepath;
      },
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "NotFoundError" || name === "TreeOrBlobNotFoundError") {
      throw new SkillLibraryError("Version not found", 404);
    }
    throw err;
  }
  if (Object.keys(files).length === 0)
    throw new SkillLibraryError("Version not found", 404);

  await assetService.populateAsset({
    assetId,
    ref: SKILL_BUNDLE_REF,
    tree: { files, clearPrefix: prefix, message: `Restore ${sha.slice(0, 7)}` },
    principal: { kind: "hub" },
  });

  const refreshed = await getSkillAsset(
    db,
    { tenantId: actor.tenantId, userId: actor.userId },
    assetId,
  );
  if (!refreshed) throw new SkillLibraryError("Skill not found", 404);
  return refreshed;
}

export async function createSkill(
  assetService: AssetService,
  db: HubDb,
  userContext: UserContext,
  input: {
    name: string;
    description?: string | null;
    files: SkillBundleFileInput[];
    scope: SkillAccessScope;
    ownerUserId: string;
    ownerName: string;
  },
): Promise<SkillItem> {
  const name = input.name.trim();
  if (!name) throw new SkillLibraryError("Skill name is required");
  const bundle = buildSkillBundle(input.files);
  const assetName = toAssetName(name);
  const fileContents = new Map<string, Buffer>(
    bundle.files.map((f) => [f.path, f.content]),
  );
  const treeFiles = buildSkillTree(
    assetName,
    input.description,
    bundle.manifest,
    fileContents,
  );

  // A slug-shaped name (e.g. "landing-page") adds no information over the
  // asset name itself — store no displayName so the render side's null path
  // humanizes it, instead of persisting a redundant raw slug as the title.
  const displayName = isSlugShaped(name) ? undefined : name;

  let asset;
  try {
    asset = await assetService.createAsset({
      tenantId: userContext.tenantId,
      kind: "skill",
      name: assetName,
      displayName,
      creatorPrincipalId: userContext.principalId,
    });
  } catch (err) {
    if (err instanceof AssetServiceError && err.reason === "duplicate_asset") {
      throw new SkillLibraryError(
        `A skill named "${name}" already exists`,
        409,
      );
    }
    throw err;
  }

  try {
    await assetService.populateAsset({
      assetId: asset.id,
      ref: SKILL_BUNDLE_REF,
      tree: {
        files: treeFiles,
        clearPrefix: `${assetName}/`,
        message: `Add ${name}`,
      },
      principal: { kind: "hub" },
    });
    // Write the access row in the same guarded scope: if it fails, the asset is
    // rolled back below rather than left as an implicit (org-wide) skill with no
    // owner — which would silently widen a skill the user marked private.
    await db.insert(skillAccess).values({
      assetId: asset.id,
      scope: input.scope,
      ownerUserId: input.ownerUserId,
      ownerPrincipalId: userContext.principalId,
      description: input.description ?? null,
    });
  } catch (err) {
    // populate or access-row write failed — delete the orphaned asset (and any
    // access row) so the caller can retry cleanly.
    await db
      .delete(intxSchema.asset)
      .where(eq(intxSchema.asset.id, asset.id))
      .catch((deleteErr) => {
        log.error("Failed to clean up orphaned asset after create failure", {
          assetId: asset.id,
          error: String(deleteErr),
        });
      });
    await db
      .delete(skillAccess)
      .where(eq(skillAccess.assetId, asset.id))
      .catch(() => {});
    throw err;
  }

  return {
    id: asset.id,
    name: asset.name,
    displayName: asset.displayName ?? null,
    description: input.description ?? null,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
    scope: input.scope,
    accessTenantId: asset.tenantId,
    ownerUserId: input.ownerUserId,
    ownerName: input.ownerName,
  };
}

export async function updateSkill(
  assetService: AssetService,
  db: HubDb,
  actor: SkillActor,
  input: {
    assetId: string;
    description?: string | null;
    files: SkillBundleFileInput[];
  },
): Promise<SkillItem> {
  const existing = await loadManageableSkill(db, actor, input.assetId);

  const assetName = existing.name;
  const bundle = buildSkillBundle(input.files);
  const fileContents = new Map<string, Buffer>(
    bundle.files.map((f) => [f.path, f.content]),
  );
  const treeFiles = buildSkillTree(
    assetName,
    input.description ?? null,
    bundle.manifest,
    fileContents,
  );

  await assetService.populateAsset({
    assetId: existing.id,
    ref: SKILL_BUNDLE_REF,
    tree: {
      files: treeFiles,
      clearPrefix: `${assetName}/`,
      message: `Update ${existing.displayName ?? assetName}`,
    },
    principal: { kind: "hub" },
  });

  // Keep skill_access.description in sync with the frontmatter written above
  // so listSkills can read it back without a per-skill git fetch. Only touch
  // the column when the caller actually sent a description, so a bare
  // content-only edit doesn't silently blank out a previously set one.
  if (input.description !== undefined) {
    await db
      .update(skillAccess)
      .set({ description: input.description })
      .where(eq(skillAccess.assetId, existing.id));
  }

  // Re-resolve through the read path so the response carries the fresh updatedAt
  // and the joined owner name (not a hardcoded null).
  const refreshed = await getSkillAsset(
    db,
    { tenantId: actor.tenantId, userId: actor.userId },
    existing.id,
  );
  if (!refreshed) throw new SkillLibraryError("Skill not found", 404);
  return refreshed;
}

// ─── Skill drafts (CL-4215) ─────────────────────────────────────────
//
// Skill drafts are storage only: authored via the `skill_draft` hub tool,
// reviewed in the web UI's Pending drafts panel, never attached to an agent
// session. They are `skill-draft`-kind assets, not `artifact` rows with a
// status column — existence is the state:
//
//   draft asset exists, no skill asset of the same name → pending review
//   skill asset exists                                  → approved
//   draft asset gone                                     → discarded
//
// The concurrency guard for a racing approve/discard is a conditional
// `DELETE ... RETURNING` on the draft asset row: exactly one caller's delete
// returns a row (the "claim"); the other gets zero rows back and 409s. This
// needs no CAS column, no lock table, no lease — the row's own existence,
// governed by ordinary Postgres MVCC, is the guard. Approve-vs-approve is
// additionally guarded by the asset unique constraint on
// (tenant, kind, name): the loser's `createAsset`/`updateSkill` publish
// races the winner's and 409s on the duplicate-asset error, which the
// existing `createSkill` fallback-to-update path already handles.
//
// A failed publish (after the claiming delete succeeds but before the skill
// asset is durably created) reinstates a fresh `skill-draft` asset with the
// claimed content, so the draft is listable and retryable — never "stuck
// approved" with no skill, because there is no approved status to get stuck
// in. A draft that is gone is either a skill (approved) or nothing
// (discarded); a failed approve leaves it existing again as pending.
//
// `rejected` is not modelled: discard deletes the row outright. No consumer
// reads a rejected draft — the client type used to advertise a three-state
// union, but nothing ever listed rejected drafts, and a discarded row now
// surfaces only as a not-found error, same as it always effectively did.

const SkillDraftSourceFileSchema = type({
  path: "string",
  content: "string",
});
const SkillDraftSourceFilesSchema = SkillDraftSourceFileSchema.array();

const SkillDraftMetaSchema = type({
  "title?": "string",
  "description?": "string | null",
  "existingSkillId?": "string | null",
});

export type SkillDraftSupportFile = {
  path: string;
  content: string;
};

export type SkillDraftItem = {
  id: string;
  title: string;
  content: string;
  description: string | null;
  existingSkillId: string | null;
  /** Support files under the draft/ prefix (SKILL.md body is `content`, not listed here). */
  files: SkillDraftSupportFile[];
  updatedAt: string;
  createdAt: string;
};

export type ApproveSkillDraftOpts = {
  scope: SkillAccessScope;
  ownerUserId: string;
  ownerName: string;
};

type SkillDraftAssetRow = {
  id: string;
  tenantId: string;
  name: string;
  displayName: string | null;
  creatorPrincipalId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type SkillDraftContent = {
  title: string | null;
  content: string;
  description: string | null;
  existingSkillId: string | null;
  files: SkillDraftSupportFile[];
};

function skillDraftRepoDir(repoStore: RepoStore, assetId: string): string {
  return repoStore.getRepoDir({ kind: "skill-draft", id: assetId });
}

async function readDraftBlob(
  repoStore: RepoStore,
  assetId: string,
  treePath: string,
  fs: typeof nodefs = nodefs,
): Promise<Buffer | null> {
  const dir = skillDraftRepoDir(repoStore, assetId);
  try {
    const commitSha = await git.resolveRef({ fs, dir, ref: SKILL_BUNDLE_REF });
    const { blob } = await git.readBlob({
      fs,
      dir,
      oid: commitSha,
      filepath: treePath,
    });
    return Buffer.from(blob);
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "NotFoundError" || name === "TreeOrBlobNotFoundError")
      return null;
    log.error("Unexpected error reading skill-draft blob", {
      assetId,
      treePath,
      error: String(err),
    });
    return null;
  }
}

async function listDraftSupportFiles(
  repoStore: RepoStore,
  assetId: string,
  fs: typeof nodefs = nodefs,
): Promise<SkillDraftSupportFile[]> {
  const dir = skillDraftRepoDir(repoStore, assetId);
  try {
    const entries = await git.walk({
      fs,
      dir,
      trees: [git.TREE({ ref: SKILL_BUNDLE_REF })],
      map: async (filepath, [entry]) => {
        if (!entry) return null;
        if ((await entry.type()) !== "blob") return undefined;
        if (!filepath.startsWith(SKILL_DRAFT_PREFIX)) return undefined;
        const relativePath = filepath.slice(SKILL_DRAFT_PREFIX.length);
        if (
          !relativePath ||
          relativePath === "SKILL.md" ||
          relativePath === ".draft-meta.json"
        ) {
          return null;
        }
        const blob = await entry.content();
        if (!blob) return null;
        let content: string;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(blob);
        } catch {
          return null; // binary support file — omitted from the review payload
        }
        return { path: relativePath, content };
      },
    });
    return (entries.filter(Boolean) as SkillDraftSupportFile[]).sort((a, b) =>
      a.path.localeCompare(b.path),
    );
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name !== "NotFoundError" && name !== "TreeOrBlobNotFoundError") {
      log.error("Unexpected error listing skill-draft support files", {
        assetId,
        error: String(err),
      });
    }
    return [];
  }
}

/** Reads a draft's full content (body, meta, support files) straight from its git repo. */
async function loadSkillDraftContent(
  repoStore: RepoStore,
  assetId: string,
  fs: typeof nodefs = nodefs,
): Promise<SkillDraftContent> {
  const [bodyBuf, metaBuf, files] = await Promise.all([
    readDraftBlob(repoStore, assetId, SKILL_DRAFT_ENTRYPOINT, fs),
    readDraftBlob(repoStore, assetId, SKILL_DRAFT_META_PATH, fs),
    listDraftSupportFiles(repoStore, assetId, fs),
  ]);

  // A draft's meta blob is written by us on every draft write, so a missing or
  // unparseable one is corruption, not a legacy shape to tolerate. Fail loudly
  // rather than silently serving a draft with empty title/description.
  let meta: {
    title?: string;
    description?: string | null;
    existingSkillId?: string | null;
  } = {};
  if (metaBuf) {
    let raw: unknown;
    try {
      raw = JSON.parse(metaBuf.toString("utf8"));
    } catch (err) {
      throw new SkillLibraryError(
        `Skill draft ${assetId} has an unparseable meta blob: ${String(err)}`,
        500,
      );
    }
    const parsed = SkillDraftMetaSchema(raw);
    if (parsed instanceof type.errors) {
      throw new SkillLibraryError(
        `Skill draft ${assetId} has an invalid meta blob: ${parsed.summary}`,
        500,
      );
    }
    meta = parsed;
  }

  return {
    title: meta.title ?? null,
    content: bodyBuf ? bodyBuf.toString("utf8") : "",
    description: meta.description ?? null,
    existingSkillId: meta.existingSkillId ?? null,
    files,
  };
}

/** Builds the draft/ tree written on every create/update/reinstate of a skill-draft asset. */
function buildSkillDraftTree(input: {
  title: string;
  description: string | null;
  existingSkillId: string | null;
  body: string;
  files: SkillDraftSupportFile[];
}): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  files[SKILL_DRAFT_ENTRYPOINT] = new TextEncoder().encode(input.body);
  const meta = {
    title: input.title,
    description: input.description,
    existingSkillId: input.existingSkillId,
  };
  files[SKILL_DRAFT_META_PATH] = new TextEncoder().encode(
    JSON.stringify(meta, null, 2),
  );
  for (const file of input.files) {
    const normalizedPath = normalizeBundlePath(file.path);
    if (
      !normalizedPath ||
      normalizedPath === "SKILL.md" ||
      normalizedPath === ".draft-meta.json"
    ) {
      continue;
    }
    files[`${SKILL_DRAFT_PREFIX}${normalizedPath}`] = new TextEncoder().encode(
      file.content,
    );
  }
  return files;
}

async function removeDraftRepoDir(
  repoStore: RepoStore,
  assetId: string,
): Promise<void> {
  const dir = skillDraftRepoDir(repoStore, assetId);
  await nodefs.promises
    .rm(dir, { recursive: true, force: true })
    .catch((err) => {
      log.error("Failed to remove skill-draft git repo", {
        assetId,
        dir,
        error: String(err),
      });
    });
}

function toSkillDraftItem(
  row: SkillDraftAssetRow,
  content: SkillDraftContent,
): SkillDraftItem {
  return {
    id: row.id,
    title: content.title ?? row.displayName ?? row.name,
    content: content.content,
    description: content.description,
    existingSkillId: content.existingSkillId,
    files: content.files,
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Match a visible library skill to a draft title. `listSkills` returns the
 * kebab asset slug in `name` and the human title in `displayName`; draft titles
 * may be either form (Myra often passes a display-ish name).
 */
export function matchSkillIdByDraftName(
  skills: readonly {
    id: string;
    name: string;
    displayName: string | null;
  }[],
  draftTitle: string,
): string | null {
  const slug = toAssetName(draftTitle);
  const match = skills.find(
    (s) =>
      s.name === slug ||
      s.name === draftTitle ||
      (s.displayName !== null &&
        (s.displayName === draftTitle || toAssetName(s.displayName) === slug)),
  );
  return match?.id ?? null;
}

async function resolveSkillIdByDraftTitle(
  db: HubDb,
  viewer: SkillViewer,
  draftTitle: string,
): Promise<string | null> {
  const visible = await listSkills(db, viewer);
  return matchSkillIdByDraftName(visible, draftTitle);
}

function draftAssetWhere(
  draftId: string,
  tenantId: string,
  ownerPrincipalId: string,
) {
  return and(
    eq(intxSchema.asset.id, draftId),
    eq(intxSchema.asset.kind, "skill-draft"),
    eq(intxSchema.asset.tenantId, tenantId),
    eq(intxSchema.asset.creatorPrincipalId, ownerPrincipalId),
  );
}

export type UpsertSkillDraftInput = {
  tenantId: string;
  /** Human owner principal (Myra's member), not the agent principal. */
  ownerPrincipalId: string;
  title: string;
  body: string;
  description: string | null | undefined;
  files: SkillDraftSupportFile[] | undefined;
  existingSkillId: string | null | undefined;
};

/**
 * Create or update the caller's pending draft for `title` — the `skill_draft`
 * tool's write path. Drafts are per-(tenant, kind, name) via the asset unique
 * constraint (the same constraint published skills use), so two different
 * users drafting the exact same title in one tenant collide with a 409 —
 * consistent with how a name collision on `createSkill` already behaves.
 */
export async function upsertSkillDraft(
  assetService: AssetService,
  db: HubDb,
  repoStore: RepoStore,
  input: UpsertSkillDraftInput,
): Promise<{ draftId: string }> {
  const title = input.title.trim();
  if (!title) throw new SkillLibraryError("Draft name is required");
  const assetName = toAssetName(title);
  const displayName = isSlugShaped(title) ? undefined : title;

  const rows = await db
    .select({
      id: intxSchema.asset.id,
      creatorPrincipalId: intxSchema.asset.creatorPrincipalId,
    })
    .from(intxSchema.asset)
    .where(
      and(
        eq(intxSchema.asset.tenantId, input.tenantId),
        eq(intxSchema.asset.kind, "skill-draft"),
        eq(intxSchema.asset.name, assetName),
      ),
    )
    .limit(1);
  const existingDraft = rows[0];

  if (
    existingDraft &&
    existingDraft.creatorPrincipalId !== input.ownerPrincipalId
  ) {
    throw new SkillLibraryError(`A draft named "${title}" already exists`, 409);
  }

  // Preserve a prior stamp when re-authoring without an explicit one.
  let existingSkillId = input.existingSkillId ?? null;
  if (existingSkillId === null && existingDraft) {
    const prior = await loadSkillDraftContent(repoStore, existingDraft.id);
    existingSkillId = prior.existingSkillId;
  }

  const description =
    input.description === undefined ? null : input.description;
  const files = input.files === undefined ? [] : input.files;
  const treeFiles = buildSkillDraftTree({
    title,
    description,
    existingSkillId,
    body: input.body,
    files,
  });

  if (existingDraft) {
    await assetService.populateAsset({
      assetId: existingDraft.id,
      ref: SKILL_BUNDLE_REF,
      tree: {
        files: treeFiles,
        clearPrefix: SKILL_DRAFT_PREFIX,
        message: `Update draft ${title}`,
      },
      principal: { kind: "hub" },
    });
    return { draftId: existingDraft.id };
  }

  let asset;
  try {
    if (displayName === undefined) {
      asset = await assetService.createAsset({
        tenantId: input.tenantId,
        kind: "skill-draft",
        name: assetName,
        creatorPrincipalId: input.ownerPrincipalId,
      });
    } else {
      asset = await assetService.createAsset({
        tenantId: input.tenantId,
        kind: "skill-draft",
        name: assetName,
        displayName,
        creatorPrincipalId: input.ownerPrincipalId,
      });
    }
  } catch (err) {
    if (err instanceof AssetServiceError && err.reason === "duplicate_asset") {
      throw new SkillLibraryError(
        `A draft named "${title}" already exists`,
        409,
      );
    }
    throw err;
  }

  try {
    await assetService.populateAsset({
      assetId: asset.id,
      ref: SKILL_BUNDLE_REF,
      tree: {
        files: treeFiles,
        clearPrefix: SKILL_DRAFT_PREFIX,
        message: `Create draft ${title}`,
      },
      principal: { kind: "hub" },
    });
  } catch (err) {
    await db
      .delete(intxSchema.asset)
      .where(eq(intxSchema.asset.id, asset.id))
      .catch((deleteErr) => {
        log.error(
          "Failed to clean up orphaned skill-draft asset after create failure",
          {
            assetId: asset.id,
            error: String(deleteErr),
          },
        );
      });
    throw err;
  }

  return { draftId: asset.id };
}

/**
 * Load one of the caller's pending drafts. Reachable exactly when
 * `listSkillDrafts` would surface the row: owned via `creatorPrincipalId`.
 * A missing id, a row the caller does not own, or a discarded/approved
 * (i.e. no-longer-existing) draft all surface as the same not-found error
 * naming the id — list and load never disagree on what is pending.
 */
export async function getOwnedSkillDraftItem(
  db: HubDb,
  repoStore: RepoStore,
  userContext: UserContext,
  draftId: string,
): Promise<SkillDraftItem> {
  const rows = await db
    .select()
    .from(intxSchema.asset)
    .where(
      draftAssetWhere(draftId, userContext.tenantId, userContext.principalId),
    )
    .limit(1);
  const row = rows[0];
  if (!row)
    throw new SkillLibraryError(`Skill draft not found: ${draftId}`, 404);
  const content = await loadSkillDraftContent(repoStore, row.id);
  return toSkillDraftItem(row, content);
}

export async function listSkillDrafts(
  db: HubDb,
  repoStore: RepoStore,
  userContext: UserContext,
): Promise<SkillDraftItem[]> {
  const rows = await db
    .select()
    .from(intxSchema.asset)
    .where(
      and(
        eq(intxSchema.asset.tenantId, userContext.tenantId),
        eq(intxSchema.asset.kind, "skill-draft"),
        eq(intxSchema.asset.creatorPrincipalId, userContext.principalId),
      ),
    )
    .orderBy(desc(intxSchema.asset.updatedAt));

  return Promise.all(
    rows.map(async (row) => {
      const content = await loadSkillDraftContent(repoStore, row.id);
      return toSkillDraftItem(row, content);
    }),
  );
}

/**
 * Discard a pending draft. The claim is a conditional `DELETE ... RETURNING`:
 * exactly one racing discard/approve gets the row back; the loser 409s. The
 * pre-check surfaces genuine not-found (never existed / not owned) as 404,
 * distinct from the 409 a real race produces.
 */
export async function discardSkillDraft(
  db: HubDb,
  repoStore: RepoStore,
  userContext: UserContext,
  draftId: string,
): Promise<{ draftId: string; title: string }> {
  const preRows = await db
    .select({ id: intxSchema.asset.id })
    .from(intxSchema.asset)
    .where(
      draftAssetWhere(draftId, userContext.tenantId, userContext.principalId),
    )
    .limit(1);
  if (!preRows[0]) {
    throw new SkillLibraryError(`Skill draft not found: ${draftId}`, 404);
  }

  const deleted = await db
    .delete(intxSchema.asset)
    .where(
      draftAssetWhere(draftId, userContext.tenantId, userContext.principalId),
    )
    .returning();
  const row = deleted[0];
  if (!row) {
    throw new SkillLibraryError("Draft is no longer pending", 409);
  }

  await removeDraftRepoDir(repoStore, row.id);
  return { draftId: row.id, title: row.displayName ?? row.name };
}

/**
 * Approve a pending draft: publish it as a skill asset (create or update),
 * then delete the draft. The claim is the same conditional delete
 * `discardSkillDraft` uses, so a racing approve and discard can never both
 * win. If the publish step fails after the claim succeeds, the draft is
 * reinstated as a fresh `skill-draft` asset carrying the claimed content —
 * unambiguously pending again, never a stuck "approved with no skill" state,
 * because there is no approved status for it to get stuck in.
 */
export async function approveSkillDraft(
  assetService: AssetService,
  db: HubDb,
  repoStore: RepoStore,
  userContext: UserContext,
  draftId: string,
  opts: ApproveSkillDraftOpts,
): Promise<{ skill: SkillItem; draftId: string }> {
  const ownerUserId = opts.ownerUserId.trim();
  const ownerName = opts.ownerName.trim();
  if (!ownerUserId || !ownerName) {
    throw new SkillLibraryError(
      "Owner identity is required to approve a draft",
      400,
    );
  }

  const preRows = await db
    .select({ id: intxSchema.asset.id })
    .from(intxSchema.asset)
    .where(
      draftAssetWhere(draftId, userContext.tenantId, userContext.principalId),
    )
    .limit(1);
  if (!preRows[0]) {
    throw new SkillLibraryError(`Skill draft not found: ${draftId}`, 404);
  }

  const deleted = await db
    .delete(intxSchema.asset)
    .where(
      draftAssetWhere(draftId, userContext.tenantId, userContext.principalId),
    )
    .returning();
  const claimed = deleted[0];
  if (!claimed) {
    throw new SkillLibraryError("Draft is no longer pending", 409);
  }

  const draftContent = await loadSkillDraftContent(repoStore, claimed.id);
  const name = draftContent.title ?? claimed.displayName ?? claimed.name;
  const description = draftContent.description;
  const scope = opts.scope === "private" ? "private" : "tenant";
  const files: SkillBundleFileInput[] = [
    { path: "SKILL.md", content: Buffer.from(draftContent.content) },
  ];
  for (const supportFile of draftContent.files) {
    files.push({
      path: supportFile.path,
      content: Buffer.from(supportFile.content),
    });
  }

  const actor: SkillActor = {
    tenantId: userContext.tenantId,
    userId: ownerUserId,
    principalId: userContext.principalId,
  };
  const viewer: SkillViewer = {
    tenantId: userContext.tenantId,
    userId: ownerUserId,
  };

  try {
    let existingSkillId = draftContent.existingSkillId;
    if (!existingSkillId) {
      existingSkillId = await resolveSkillIdByDraftTitle(db, viewer, name);
    }

    let skill: SkillItem;
    if (existingSkillId) {
      const target = await getSkillAsset(db, viewer, existingSkillId);
      if (!target) {
        throw new SkillLibraryError("Skill not found", 404);
      }
      if (matchSkillIdByDraftName([target], name) !== target.id) {
        throw new SkillLibraryError(
          `Draft title "${name}" does not match skill "${target.displayName ?? target.name}"`,
          400,
        );
      }
      skill = await updateSkill(assetService, db, actor, {
        assetId: existingSkillId,
        description,
        files,
      });
    } else {
      try {
        skill = await createSkill(assetService, db, userContext, {
          name,
          description,
          files,
          scope,
          ownerUserId,
          ownerName,
        });
      } catch (createErr) {
        // 409 name collision: skill exists but wasn't linked — fall through to
        // update so approve never has to reinstate on a resolvable collision.
        if (
          !(createErr instanceof SkillLibraryError) ||
          createErr.status !== 409
        ) {
          throw createErr;
        }
        const fallbackId = await resolveSkillIdByDraftTitle(db, viewer, name);
        if (!fallbackId) throw createErr;
        skill = await updateSkill(assetService, db, actor, {
          assetId: fallbackId,
          description,
          files,
        });
      }
    }

    await removeDraftRepoDir(repoStore, claimed.id);
    return { skill, draftId: claimed.id };
  } catch (err) {
    try {
      let reinstated;
      if (claimed.displayName === null) {
        reinstated = await assetService.createAsset({
          tenantId: userContext.tenantId,
          kind: "skill-draft",
          name: claimed.name,
          creatorPrincipalId: userContext.principalId,
        });
      } else {
        reinstated = await assetService.createAsset({
          tenantId: userContext.tenantId,
          kind: "skill-draft",
          name: claimed.name,
          displayName: claimed.displayName,
          creatorPrincipalId: userContext.principalId,
        });
      }
      await assetService.populateAsset({
        assetId: reinstated.id,
        ref: SKILL_BUNDLE_REF,
        tree: {
          files: buildSkillDraftTree({
            title: name,
            description,
            existingSkillId: draftContent.existingSkillId,
            body: draftContent.content,
            files: draftContent.files,
          }),
          clearPrefix: SKILL_DRAFT_PREFIX,
          message: "Reinstate draft after failed publish",
        },
        principal: { kind: "hub" },
      });
    } catch (reinstateErr) {
      log.error(
        "skill-draft approve failed and could not reinstate the draft; content only survives in the orphaned repo",
        {
          draftId,
          tenantId: userContext.tenantId,
          error:
            reinstateErr instanceof Error
              ? reinstateErr.message
              : String(reinstateErr),
        },
      );
    } finally {
      await removeDraftRepoDir(repoStore, claimed.id).catch(() => {});
    }
    throw err;
  }
}
