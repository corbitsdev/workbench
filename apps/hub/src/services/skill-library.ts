import { createHash } from 'node:crypto';
import { normalize, sep } from 'node:path';
import nodefs from 'node:fs';
import git from 'isomorphic-git';
import JSZip from 'jszip';
import { and, asc, eq } from 'drizzle-orm';
import { schema as intxSchema } from '@intx/db';
import { getLogger } from '@intx/log';
import type { HubDb } from '../db';
import type { AssetService, RepoStore } from '@intx/hub-sessions';
import { AssetServiceError } from '@intx/hub-sessions';
import type { UserContext } from '@workbench/workflow-core';

const log = getLogger(['skill-library']);

export const MAX_SKILL_BUNDLE_BYTES = 20 * 1024 * 1024;
export const MAX_SKILL_FILE_COUNT = 200;
export const MAX_PROMPT_FILE_BYTES = 256 * 1024;

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.css',
  '.html',
]);

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.sh',
  '.bash',
]);

const JUNK_PATHS = new Set(['.DS_Store', 'Thumbs.db']);

type JSZipEntryWithMetadata = JSZip.JSZipObject & {
  _data?: { uncompressedSize?: number };
};

export type SkillCreateSource = 'paste' | 'file' | 'folder' | 'zip';

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

export type SkillItem = {
  id: string;
  name: string;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
};

export class SkillLibraryError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = 'SkillLibraryError';
  }
}

const SKILL_BUNDLE_REF = 'refs/heads/main';

function extension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot).toLowerCase() : '';
}

function normalizeBundlePath(path: string): string | null {
  const unixPath = path.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!unixPath || unixPath.includes('\0')) return null;
  if (unixPath.startsWith('../') || unixPath.includes('/../') || unixPath === '..') return null;
  const normalized = normalize(unixPath).replaceAll(sep, '/');
  if (normalized.startsWith('../') || normalized.startsWith('/') || normalized === '..')
    return null;
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..' || part === '')) return null;
  if (parts[0] === '__MACOSX') return null;
  if (JUNK_PATHS.has(parts.at(-1) ?? '')) return null;
  return normalized;
}

function isPromptReadable(path: string, mimeType: string, size: number): boolean {
  if (size > MAX_PROMPT_FILE_BYTES) return false;
  if (mimeType.startsWith('text/')) return true;
  if (mimeType === 'application/json') return true;
  return TEXT_EXTENSIONS.has(extension(path));
}

function isExecutableLike(path: string): boolean {
  return CODE_EXTENSIONS.has(extension(path));
}

function chooseEntrypoint(paths: string[]): string {
  const exact = paths.find((path) => path === 'SKILL.md');
  if (exact) return exact;
  const nested = paths.find((path) => path.endsWith('/SKILL.md'));
  if (nested) return nested;
  const markdown = paths.find((path) => path.toLowerCase().endsWith('.md'));
  if (markdown) return markdown;
  throw new SkillLibraryError('Skill bundle must include SKILL.md or at least one markdown file');
}

export type SkillBundle = {
  manifest: SkillBundleManifest;
  files: Array<{ path: string; content: Buffer; mimeType: string }>;
};

export function buildSkillBundle(files: SkillBundleFileInput[]): SkillBundle {
  if (files.length === 0)
    throw new SkillLibraryError('Skill bundle must include at least one file');
  if (files.length > MAX_SKILL_FILE_COUNT) {
    throw new SkillLibraryError(`Skill bundle exceeds the ${MAX_SKILL_FILE_COUNT} file limit`, 413);
  }

  const normalizedFiles: SkillBundleFileInput[] = [];
  const seen = new Set<string>();
  let totalSize = 0;

  for (const file of files) {
    const normalizedPath = normalizeBundlePath(file.path);
    if (!normalizedPath) throw new SkillLibraryError(`Unsafe skill bundle path: ${file.path}`);
    if (seen.has(normalizedPath))
      throw new SkillLibraryError(`Duplicate skill bundle path: ${normalizedPath}`);
    seen.add(normalizedPath);
    totalSize += file.content.byteLength;
    if (totalSize > MAX_SKILL_BUNDLE_BYTES) {
      throw new SkillLibraryError(
        `Skill bundle exceeds the ${MAX_SKILL_BUNDLE_BYTES} byte limit`,
        413
      );
    }
    if (file.content.byteLength === 0) continue;
    normalizedFiles.push({ ...file, path: normalizedPath });
  }

  if (normalizedFiles.length === 0) throw new SkillLibraryError('Skill bundle files are empty');

  const entrypointPath = chooseEntrypoint(normalizedFiles.map((file) => file.path));
  const manifestFiles = normalizedFiles
    .map((file) => {
      const mimeType = file.mimeType || 'application/octet-stream';
      return {
        path: file.path,
        size: file.content.byteLength,
        mimeType,
        sha256: createHash('sha256').update(file.content).digest('hex'),
        promptReadable: isPromptReadable(file.path, mimeType, file.content.byteLength),
        executableLike: isExecutableLike(file.path),
      } satisfies SkillBundleManifestFile;
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  const checksum = createHash('sha256')
    .update(JSON.stringify(manifestFiles.map(({ path, sha256 }) => ({ path, sha256 }))))
    .digest('hex');

  return {
    manifest: { files: manifestFiles, entrypointPath, totalSize, checksum },
    files: normalizedFiles.map((file) => ({
      path: file.path,
      content: Buffer.from(file.content),
      mimeType: file.mimeType || 'application/octet-stream',
    })),
  };
}

export async function filesFromZip(content: Buffer): Promise<SkillBundleFileInput[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(content);
  } catch {
    throw new SkillLibraryError('Invalid zip archive');
  }

  const files: SkillBundleFileInput[] = [];
  let totalSize = 0;
  for (const rawEntry of Object.values(zip.files)) {
    const entry = rawEntry as JSZipEntryWithMetadata;
    if (entry.dir) continue;
    if (files.length >= MAX_SKILL_FILE_COUNT) {
      throw new SkillLibraryError(
        `Skill bundle exceeds the ${MAX_SKILL_FILE_COUNT} file limit`,
        413
      );
    }
    const declaredSize = entry._data?.uncompressedSize;
    if (declaredSize !== undefined && totalSize + declaredSize > MAX_SKILL_BUNDLE_BYTES) {
      throw new SkillLibraryError(
        `Skill bundle exceeds the ${MAX_SKILL_BUNDLE_BYTES} byte limit`,
        413
      );
    }
    const fileContent = Buffer.from(await entry.async('uint8array'));
    totalSize += fileContent.byteLength;
    if (totalSize > MAX_SKILL_BUNDLE_BYTES) {
      throw new SkillLibraryError(
        `Skill bundle exceeds the ${MAX_SKILL_BUNDLE_BYTES} byte limit`,
        413
      );
    }
    files.push({
      path: entry.name,
      content: fileContent,
      mimeType: 'application/octet-stream',
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
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'skill'
  );
}

function bundlePrefixFromEntrypoint(entrypointPath: string): string {
  const slashIdx = entrypointPath.lastIndexOf('/');
  return slashIdx >= 0 ? entrypointPath.slice(0, slashIdx + 1) : '';
}

function stripBundlePrefix(filePath: string, bundlePrefix: string): string {
  return filePath.startsWith(bundlePrefix) ? filePath.slice(bundlePrefix.length) : filePath;
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
  fileContents: Map<string, Buffer>
): Record<string, Uint8Array> {
  const bundlePrefix = bundlePrefixFromEntrypoint(bundle.entrypointPath);

  const files: Record<string, Uint8Array> = {};
  for (const file of bundle.files) {
    const content = fileContents.get(file.path);
    if (!content) throw new Error(`Missing content for bundle file: ${file.path}`);
    const treePath = `${assetName}/${stripBundlePrefix(file.path, bundlePrefix)}`;
    files[treePath] = content;
  }

  const entrypointTreePath = `${assetName}/SKILL.md`;
  const originalEntrypointKey = `${assetName}/${stripBundlePrefix(bundle.entrypointPath, bundlePrefix)}`;
  const existingContent = files[entrypointTreePath] ?? files[originalEntrypointKey];
  // Remove the original entrypoint file if it mapped to a different tree path
  // so we don't end up with both `assetName/docs/SKILL.md` and `assetName/SKILL.md`.
  if (originalEntrypointKey !== entrypointTreePath) {
    delete files[originalEntrypointKey];
  }
  const bodyText = existingContent ? new TextDecoder().decode(existingContent) : '';
  const strippedBody = bodyText.replace(/^---[\s\S]*?---\n?/, '');
  const frontmatter = `---\nname: ${assetName}\ndescription: "${(description ?? 'Skill').replace(/"/g, '\\"')}"\n---\n`;
  files[entrypointTreePath] = new TextEncoder().encode(frontmatter + strippedBody);

  return files;
}

export async function deleteSkill(
  db: HubDb,
  repoStore: RepoStore,
  tenantId: string,
  assetId: string,
  principalId: string
): Promise<void> {
  const row = await db.query.asset.findFirst({
    where: and(
      eq(intxSchema.asset.id, assetId),
      eq(intxSchema.asset.tenantId, tenantId),
      eq(intxSchema.asset.kind, 'skill')
    ),
  });
  if (!row) throw new SkillLibraryError('Skill not found', 404);
  if (row.creatorPrincipalId !== principalId) {
    throw new SkillLibraryError('You do not have permission to delete this skill', 403);
  }
  // Delete DB row first — cascade removes agent_asset rows. Then remove the
  // git repo from disk. If the fs.rm fails we log and continue; the row is
  // already gone so the skill is invisible regardless.
  await db.delete(intxSchema.asset).where(eq(intxSchema.asset.id, assetId));
  const repoDir = repoStore.getRepoDir({ kind: 'skill', id: assetId });
  await nodefs.promises.rm(repoDir, { recursive: true, force: true }).catch((err) => {
    log.error('Failed to remove skill git repo after delete', {
      assetId,
      repoDir,
      error: String(err),
    });
  });
}

export async function listSkills(db: HubDb, tenantId: string): Promise<SkillItem[]> {
  const rows = await db
    .select({
      id: intxSchema.asset.id,
      name: intxSchema.asset.name,
      displayName: intxSchema.asset.displayName,
      createdAt: intxSchema.asset.createdAt,
      updatedAt: intxSchema.asset.updatedAt,
    })
    .from(intxSchema.asset)
    .where(and(eq(intxSchema.asset.tenantId, tenantId), eq(intxSchema.asset.kind, 'skill')))
    .orderBy(asc(intxSchema.asset.createdAt));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    displayName: row.displayName ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function getSkillAsset(
  db: HubDb,
  tenantId: string,
  assetId: string
): Promise<SkillItem | null> {
  const row = await db.query.asset.findFirst({
    where: and(
      eq(intxSchema.asset.id, assetId),
      eq(intxSchema.asset.tenantId, tenantId),
      eq(intxSchema.asset.kind, 'skill')
    ),
  });
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function readAssetFile(
  repoStore: RepoStore,
  assetId: string,
  treePath: string,
  fs: typeof nodefs = nodefs
): Promise<Buffer | null> {
  const dir = repoStore.getRepoDir({ kind: 'skill', id: assetId });
  try {
    const { blob } = await git.readBlob({ fs, dir, oid: SKILL_BUNDLE_REF, filepath: treePath });
    return Buffer.from(blob);
  } catch (err) {
    // Distinguish "file not in tree" (NotFoundError) from storage failures.
    const name = err instanceof Error ? err.name : '';
    if (name === 'NotFoundError' || name === 'TreeOrBlobNotFoundError') return null;
    log.error('Unexpected error reading asset file', { assetId, treePath, error: String(err) });
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
  assetName: string
): Promise<string | null> {
  const content = await readAssetFile(repoStore, assetId, `${assetName}/SKILL.md`);
  return content ? content.toString('utf8') : null;
}

export async function getSkillContent(
  repoStore: RepoStore,
  assetId: string,
  assetName: string,
  fs: typeof nodefs = nodefs
): Promise<{ path: string; content?: string }[]> {
  const dir = repoStore.getRepoDir({ kind: 'skill', id: assetId });
  const prefix = `${assetName}/`;

  try {
    const entries = await git.walk({
      fs,
      dir,
      trees: [git.TREE({ ref: SKILL_BUNDLE_REF })],
      map: async (filepath, [entry]) => {
        if (!entry || (await entry.type()) !== 'blob') return null;
        if (!filepath.startsWith(prefix)) return null;
        const relativePath = filepath.slice(prefix.length);
        if (!relativePath) return null;
        const blob = await entry.content();
        let content: string | undefined;
        if (blob) {
          try {
            content = new TextDecoder('utf-8', { fatal: true }).decode(blob);
          } catch {
            // binary file — omit content
          }
        }
        // Strip the Interchange-injected YAML frontmatter from the entrypoint
        // file — it is an internal contract with the skillKindHandler, not user content.
        const displayContent =
          relativePath === 'SKILL.md' && content
            ? content.replace(/^---[\s\S]*?---\n?/, '')
            : content;
        return { path: relativePath, content: displayContent };
      },
    });
    return (entries.filter(Boolean) as { path: string; content?: string }[]).sort((a, b) =>
      a.path.localeCompare(b.path)
    );
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name !== 'NotFoundError' && name !== 'TreeOrBlobNotFoundError') {
      log.error('Unexpected error reading skill content', { assetId, error: String(err) });
    }
    return [];
  }
}

export async function createSkill(
  assetService: AssetService,
  db: HubDb,
  userContext: UserContext,
  input: {
    name: string;
    description?: string | null;
    files: SkillBundleFileInput[];
  }
): Promise<SkillItem> {
  const name = input.name.trim();
  if (!name) throw new SkillLibraryError('Skill name is required');
  const bundle = buildSkillBundle(input.files);
  const assetName = toAssetName(name);
  const fileContents = new Map<string, Buffer>(bundle.files.map((f) => [f.path, f.content]));
  const treeFiles = buildSkillTree(assetName, input.description, bundle.manifest, fileContents);

  let asset;
  try {
    asset = await assetService.createAsset({
      tenantId: userContext.tenantId,
      kind: 'skill',
      name: assetName,
      displayName: name,
      creatorPrincipalId: userContext.principalId,
    });
  } catch (err) {
    if (err instanceof AssetServiceError && err.reason === 'duplicate_asset') {
      throw new SkillLibraryError(`A skill named "${name}" already exists`, 409);
    }
    throw err;
  }

  try {
    await assetService.populateAsset({
      assetId: asset.id,
      ref: SKILL_BUNDLE_REF,
      tree: { files: treeFiles, clearPrefix: `${assetName}/`, message: `Add ${name}` },
      principal: { kind: 'hub' },
    });
  } catch (err) {
    // populateAsset failed — delete the orphaned asset row so the caller can retry.
    await db
      .delete(intxSchema.asset)
      .where(eq(intxSchema.asset.id, asset.id))
      .catch((deleteErr) => {
        log.error('Failed to clean up orphaned asset after populateAsset failure', {
          assetId: asset.id,
          error: String(deleteErr),
        });
      });
    throw err;
  }

  return {
    id: asset.id,
    name: asset.name,
    displayName: asset.displayName ?? null,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
  };
}

export async function updateSkill(
  assetService: AssetService,
  db: HubDb,
  userContext: UserContext,
  input: {
    assetId: string;
    description?: string | null;
    files: SkillBundleFileInput[];
  }
): Promise<SkillItem> {
  const existing = await db.query.asset.findFirst({
    where: and(
      eq(intxSchema.asset.id, input.assetId),
      eq(intxSchema.asset.tenantId, userContext.tenantId),
      eq(intxSchema.asset.kind, 'skill')
    ),
  });
  if (!existing) throw new SkillLibraryError('Skill not found', 404);

  const assetName = existing.name;
  const bundle = buildSkillBundle(input.files);
  const fileContents = new Map<string, Buffer>(bundle.files.map((f) => [f.path, f.content]));
  const treeFiles = buildSkillTree(
    assetName,
    input.description ?? null,
    bundle.manifest,
    fileContents
  );

  await assetService.populateAsset({
    assetId: existing.id,
    ref: SKILL_BUNDLE_REF,
    tree: {
      files: treeFiles,
      clearPrefix: `${assetName}/`,
      message: `Update ${existing.displayName ?? assetName}`,
    },
    principal: { kind: 'hub' },
  });

  // Re-read updatedAt from DB so the returned timestamp reflects what was actually written.
  const refreshed = await db.query.asset.findFirst({
    where: eq(intxSchema.asset.id, existing.id),
  });

  return {
    id: existing.id,
    name: existing.name,
    displayName: existing.displayName ?? null,
    createdAt: existing.createdAt.toISOString(),
    updatedAt: (refreshed?.updatedAt ?? new Date()).toISOString(),
  };
}
