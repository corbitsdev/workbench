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
import { artifact, skillAccess } from "../db/schema";
import type { AssetService, RepoStore } from "@intx/hub-sessions";
import { AssetServiceError } from "@intx/hub-sessions";
import { resolveOwnerMemberPrincipalId } from "../lib/artifact-tools";
import type { UserContext } from "../lib/user-context";

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

/**
 * Converts a display name to a lowercase-kebab asset name that satisfies
 * the Interchange skill asset name pattern /^[a-z0-9]+(-[a-z0-9]+)*$/.
 */
export function toAssetName(displayName: string): string {
  return (
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "skill"
  );
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

  let asset;
  try {
    asset = await assetService.createAsset({
      tenantId: userContext.tenantId,
      kind: "skill",
      name: assetName,
      displayName: name,
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

const SkillDraftSourceFileSchema = type({
  path: "string",
  content: "string",
});
const SkillDraftSourceFilesSchema = SkillDraftSourceFileSchema.array();

export type SkillDraftItem = {
  id: string;
  title: string;
  content: string;
  description: string | null;
  existingSkillId: string | null;
  status: "draft" | "approved" | "rejected";
  updatedAt: string;
  createdAt: string;
};

export type ApproveSkillDraftOpts = {
  scope: SkillAccessScope;
  ownerUserId: string;
  ownerName: string;
};

/**
 * Authorize the human caller against a skill-draft. Stamped ownerPrincipalId is
 * the sole gate when present; unstamped legacy rows fall back to resolving the
 * agent principal's owning member (or direct principal match for human-authored).
 */
export async function canActOnSkillDraft(
  db: HubDb,
  draft: {
    ownerPrincipalId: string | null;
    principalId: string | null;
    tenantId: string | null;
  },
  userContext: UserContext,
): Promise<boolean> {
  if (draft.ownerPrincipalId != null) {
    return draft.ownerPrincipalId === userContext.principalId;
  }
  if (draft.principalId === userContext.principalId) return true;
  if (!draft.principalId || !draft.tenantId) return false;
  const owner = await resolveOwnerMemberPrincipalId(db, {
    tenantId: draft.tenantId,
    principalId: draft.principalId,
  });
  return owner === userContext.principalId;
}

async function loadOwnedSkillDraft(
  db: HubDb,
  userContext: UserContext,
  draftId: string,
): Promise<typeof artifact.$inferSelect> {
  const rows = await db
    .select()
    .from(artifact)
    .where(
      and(
        eq(artifact.id, draftId),
        eq(artifact.kind, "skill-draft"),
        eq(artifact.tenantId, userContext.tenantId),
      ),
    )
    .limit(1);

  const draft = rows[0];
  if (!draft) throw new SkillLibraryError("Draft not found", 404);
  const allowed = await canActOnSkillDraft(db, draft, userContext);
  if (!allowed) throw new SkillLibraryError("Draft not found", 404);
  return draft;
}

function draftSourceDescription(
  source: Record<string, unknown>,
): string | null {
  return typeof source.description === "string" ? source.description : null;
}

function draftExistingSkillId(source: Record<string, unknown>): string | null {
  return typeof source.existingSkillId === "string" && source.existingSkillId
    ? source.existingSkillId
    : null;
}

function filesFromSkillDraft(
  draft: typeof artifact.$inferSelect,
): SkillBundleFileInput[] {
  const source = (draft.source ?? {}) as Record<string, unknown>;
  const files: SkillBundleFileInput[] = [
    { path: "SKILL.md", content: Buffer.from(draft.content ?? "") },
  ];

  if (source.files === undefined) return files;

  const parsed = SkillDraftSourceFilesSchema(source.files);
  if (parsed instanceof type.errors) {
    throw new SkillLibraryError(`Invalid draft files: ${parsed.summary}`, 400);
  }

  for (const file of parsed) {
    const normalizedPath = normalizeBundlePath(file.path);
    if (!normalizedPath) {
      throw new SkillLibraryError(`Unsafe skill bundle path: ${file.path}`);
    }
    // Body is the SKILL.md entrypoint; skip duplicates from source.files.
    if (normalizedPath === "SKILL.md") continue;
    files.push({
      path: normalizedPath,
      content: Buffer.from(file.content),
    });
  }
  return files;
}

function toSkillDraftItem(draft: typeof artifact.$inferSelect): SkillDraftItem {
  const source = (draft.source ?? {}) as Record<string, unknown>;
  return {
    id: draft.id,
    title: draft.title,
    content: draft.content ?? "",
    description: draftSourceDescription(source),
    existingSkillId: draftExistingSkillId(source),
    status: draft.status,
    updatedAt: draft.updatedAt.toISOString(),
    createdAt: draft.createdAt.toISOString(),
  };
}

export async function listSkillDrafts(
  db: HubDb,
  userContext: UserContext,
): Promise<SkillDraftItem[]> {
  const rows = await db
    .select()
    .from(artifact)
    .where(
      and(
        eq(artifact.tenantId, userContext.tenantId),
        eq(artifact.kind, "skill-draft"),
        eq(artifact.status, "draft"),
        eq(artifact.ownerPrincipalId, userContext.principalId),
      ),
    )
    .orderBy(desc(artifact.updatedAt));

  return rows.map(toSkillDraftItem);
}

export async function discardSkillDraft(
  db: HubDb,
  userContext: UserContext,
  draftId: string,
): Promise<SkillDraftItem> {
  const draft = await loadOwnedSkillDraft(db, userContext, draftId);
  if (draft.status !== "draft") {
    throw new SkillLibraryError("Draft is not in draft status", 400);
  }

  const [updated] = await db
    .update(artifact)
    .set({ status: "rejected", updatedAt: new Date() })
    .where(
      and(
        eq(artifact.id, draftId),
        eq(artifact.tenantId, userContext.tenantId),
        eq(artifact.kind, "skill-draft"),
      ),
    )
    .returning();

  if (!updated) throw new SkillLibraryError("Draft not found", 404);
  return toSkillDraftItem(updated);
}

export async function approveSkillDraft(
  assetService: AssetService,
  db: HubDb,
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

  const draft = await loadOwnedSkillDraft(db, userContext, draftId);
  if (draft.status !== "draft") {
    throw new SkillLibraryError("Draft is not in draft status", 400);
  }

  const source = (draft.source ?? {}) as Record<string, unknown>;
  const files = filesFromSkillDraft(draft);
  const description = draftSourceDescription(source);
  const name = draft.title;
  const scope = opts.scope === "private" ? "private" : "tenant";
  const existingSkillId = draftExistingSkillId(source);

  let skill: SkillItem;
  if (existingSkillId) {
    const actor: SkillActor = {
      tenantId: userContext.tenantId,
      userId: ownerUserId,
      principalId: userContext.principalId,
    };
    skill = await updateSkill(assetService, db, actor, {
      assetId: existingSkillId,
      description,
      files,
    });
  } else {
    skill = await createSkill(assetService, db, userContext, {
      name,
      description,
      files,
      scope,
      ownerUserId,
      ownerName,
    });
  }

  await db
    .update(artifact)
    .set({ status: "approved", updatedAt: new Date() })
    .where(
      and(
        eq(artifact.id, draftId),
        eq(artifact.tenantId, userContext.tenantId),
        eq(artifact.kind, "skill-draft"),
      ),
    );

  return { skill, draftId };
}
