import { createHash } from 'node:crypto';
import { normalize, sep } from 'node:path';
import nodefs from 'node:fs';
import git from 'isomorphic-git';
import { type } from 'arktype';
import JSZip from 'jszip';
import { and, desc, eq, isNull, max } from 'drizzle-orm';
import type { HubDb } from '../db';
import { skill, skillVersion } from '../db/schema';
import type { UserContext } from '@workbench/workflow-core';
import { getLogger } from '@intx/log';
import type { AssetService, RepoStore } from '@intx/hub-sessions';

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

const SkillBundleManifestValidator = type({
  files: type({
    path: 'string',
    size: 'number',
    mimeType: 'string',
    sha256: 'string',
    promptReadable: 'boolean',
    executableLike: 'boolean',
  }).array(),
  entrypointPath: 'string',
  totalSize: 'number',
  checksum: 'string',
});

function parseManifest(value: unknown): SkillBundleManifest {
  const result = SkillBundleManifestValidator(value);
  if (result instanceof type.errors) {
    throw new SkillLibraryError(`Invalid skill bundle manifest: ${result.summary}`, 500);
  }
  return result as SkillBundleManifest;
}

export type SkillListItem = {
  id: string;
  name: string;
  description: string | null;
  visibility: string;
  latestVersionId: string | null;
  latestVersion: number | null;
  source: SkillCreateSource | null;
  fileCount: number | null;
  createdAt: string;
  updatedAt: string;
};

export type SkillVersionView = {
  id: string;
  skillId: string;
  version: number;
  entrypointPath: string;
  manifest: SkillBundleManifest;
  checksum: string;
  source: SkillCreateSource | null;
  createdAt: string;
};

export type SkillDetail = SkillListItem & {
  versions: SkillVersionView[];
};

const log = getLogger(['skill-library']);
const SKILL_BUNDLE_REF = 'refs/heads/main';

function stripBundlePrefix(filePath: string, bundlePrefix: string): string {
  return filePath.startsWith(bundlePrefix) ? filePath.slice(bundlePrefix.length) : filePath;
}

function bundlePrefixFromEntrypoint(entrypointPath: string): string {
  const slashIdx = entrypointPath.lastIndexOf('/');
  return slashIdx >= 0 ? entrypointPath.slice(0, slashIdx + 1) : '';
}

/**
 * Converts a display name to a lowercase-kebab asset name that satisfies
 * the Interchange skill asset name pattern /^[a-z0-9]+(-[a-z0-9]+)*$/.
 */
export function toAssetName(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'skill';
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

  // Inject/replace SKILL.md frontmatter so the skill kind handler accepts it.
  const entrypointTreePath = `${assetName}/SKILL.md`;
  const existingContent =
    files[entrypointTreePath] ??
    files[`${assetName}/${stripBundlePrefix(bundle.entrypointPath, bundlePrefix)}`];
  const bodyText = existingContent ? new TextDecoder().decode(existingContent) : '';
  const strippedBody = bodyText.replace(/^---[\s\S]*?---\n?/, '');
  const frontmatter = `---\nname: ${assetName}\ndescription: "${(description ?? 'Skill').replace(/"/g, '\\"')}"\n---\n`;
  files[entrypointTreePath] = new TextEncoder().encode(frontmatter + strippedBody);

  return files;
}

/**
 * Reads a single file from a skill asset repo at HEAD via isogit.
 */
async function readSkillFile(
  repoStore: RepoStore,
  assetId: string,
  treePath: string,
  fs: typeof nodefs = nodefs
): Promise<Buffer | null> {
  const dir = repoStore.getRepoDir({ kind: 'skill', id: assetId });
  try {
    const { blob } = await git.readBlob({ fs, dir, oid: 'HEAD', filepath: treePath });
    return Buffer.from(blob);
  } catch {
    return null;
  }
}

function isSkillCreateSource(value: unknown): value is SkillCreateSource {
  return value === 'paste' || value === 'file' || value === 'folder' || value === 'zip';
}

export class SkillLibraryError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = 'SkillLibraryError';
  }
}

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

function serializeSkillRow(row: {
  id: string;
  name: string;
  description: string | null;
  visibility: string;
  latestVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  latestVersion?: number | null;
  source?: string | null;
  fileCount?: number | null;
}): SkillListItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    latestVersionId: row.latestVersionId,
    latestVersion: row.latestVersion ?? null,
    source: isSkillCreateSource(row.source) ? row.source : null,
    fileCount: row.fileCount ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeVersion(row: typeof skillVersion.$inferSelect): SkillVersionView {
  return {
    id: row.id,
    skillId: row.skillId,
    version: row.version,
    entrypointPath: row.entrypointPath,
    manifest: parseManifest(row.manifest),
    checksum: row.checksum,
    source: (row.source as SkillCreateSource | null) ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listSkills(db: HubDb, tenantId: string): Promise<SkillListItem[]> {
  const rows = await db
    .select({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      visibility: skill.visibility,
      latestVersionId: skill.latestVersionId,
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
      latestVersion: skillVersion.version,
      source: skillVersion.source,
      fileCount: skillVersion.fileCount,
    })
    .from(skill)
    .leftJoin(skillVersion, eq(skill.latestVersionId, skillVersion.id))
    .where(and(eq(skill.tenantId, tenantId), isNull(skill.archivedAt)))
    .orderBy(desc(skill.updatedAt));

  return rows.map(serializeSkillRow);
}

export async function getSkillDetail(
  db: HubDb,
  tenantId: string,
  skillId: string
): Promise<SkillDetail | null> {
  const row = await db.query.skill.findFirst({
    where: and(eq(skill.id, skillId), eq(skill.tenantId, tenantId), isNull(skill.archivedAt)),
  });
  if (!row) return null;
  const versions = await db.query.skillVersion.findMany({
    where: eq(skillVersion.skillId, skillId),
    orderBy: [desc(skillVersion.version)],
  });
  const latest = versions.find((version) => version.id === row.latestVersionId) ?? versions[0];
  return {
    ...serializeSkillRow({
      ...row,
      latestVersion: latest?.version ?? null,
      source: (latest?.source as SkillCreateSource | null | undefined) ?? null,
      fileCount: latest?.fileCount ?? null,
    }),
    versions: versions.map(serializeVersion),
  };
}

export async function createSkillVersionFromBundle(
  db: HubDb,
  userContext: UserContext,
  assetService: AssetService,
  input: {
    name: string;
    description?: string | null;
    existingSkillId?: string;
    source?: SkillCreateSource;
    files: SkillBundleFileInput[];
  }
): Promise<SkillDetail> {
  const name = input.name.trim();
  if (!name) throw new SkillLibraryError('Skill name is required');
  const bundle = buildSkillBundle(input.files);
  const assetName = toAssetName(name);

  const fileContents = new Map<string, Buffer>(bundle.files.map((f) => [f.path, f.content]));

  const treeFiles = buildSkillTree(assetName, input.description, bundle.manifest, fileContents);

  // Create the asset repo and populate it outside the DB transaction so a
  // git failure doesn't leave an orphaned Postgres row.
  const asset = await assetService.createAsset({
    tenantId: userContext.tenantId,
    kind: 'skill',
    name: assetName,
    displayName: name,
    creatorPrincipalId: userContext.principalId,
  });

  await assetService.populateAsset({
    assetId: asset.id,
    ref: SKILL_BUNDLE_REF,
    tree: { files: treeFiles, clearPrefix: `${assetName}/`, message: `Add ${name} v1` },
    principal: { kind: 'hub' },
  });

  let result: { skillId: string };
  try {
    result = await db.transaction(async (tx) => {
    let skillId = input.existingSkillId;
    if (skillId) {
      const existing = await tx.query.skill.findFirst({
        where: and(
          eq(skill.id, skillId),
          eq(skill.tenantId, userContext.tenantId),
          isNull(skill.archivedAt)
        ),
      });
      if (!existing) throw new SkillLibraryError('Skill not found', 404);
      await tx
        .update(skill)
        .set({ name, description: input.description ?? existing.description })
        .where(eq(skill.id, skillId));
    } else {
      const [created] = await tx
        .insert(skill)
        .values({
          tenantId: userContext.tenantId,
          name,
          description: input.description ?? null,
          visibility: 'workspace',
          createdBy: userContext.principalId,
        })
        .returning();
      if (!created) throw new SkillLibraryError('Failed to create skill', 500);
      skillId = created.id;
    }

    const latestRows = await tx
      .select({ value: max(skillVersion.version) })
      .from(skillVersion)
      .where(eq(skillVersion.skillId, skillId));
    const nextVersion = (latestRows[0]?.value ?? 0) + 1;

    const [createdVersion] = await tx
      .insert(skillVersion)
      .values({
        skillId,
        version: nextVersion,
        entrypointPath: bundle.manifest.entrypointPath,
        assetId: asset.id,
        assetName,
        manifest: bundle.manifest,
        checksum: bundle.manifest.checksum,
        source: input.source ?? 'file',
        fileCount: bundle.manifest.files.length,
        createdBy: userContext.principalId,
      })
      .returning();
    if (!createdVersion) throw new SkillLibraryError('Failed to create skill version', 500);

    await tx.update(skill).set({ latestVersionId: createdVersion.id }).where(eq(skill.id, skillId));

      return { skillId };
    });
  } catch (err) {
    // AssetService has no deleteAsset; log the orphaned asset so it can be
    // cleaned up out-of-band if needed.
    log.error('skill_version DB transaction failed after asset creation — asset orphaned', {
      assetId: asset.id,
      assetName,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const detail = await getSkillDetail(db, userContext.tenantId, result.skillId);
  if (!detail) throw new SkillLibraryError('Skill not found after creation', 500);
  return detail;
}

export async function resolveSkillVersionPrompt(
  db: HubDb,
  repoStore: RepoStore,
  tenantId: string,
  versionId: string
): Promise<string | null> {
  const row = await db
    .select({
      skillName: skill.name,
      assetName: skillVersion.assetName,
      version: skillVersion.version,
      entrypointPath: skillVersion.entrypointPath,
      assetId: skillVersion.assetId,
      manifest: skillVersion.manifest,
    })
    .from(skillVersion)
    .innerJoin(skill, eq(skill.id, skillVersion.skillId))
    .where(
      and(eq(skillVersion.id, versionId), eq(skill.tenantId, tenantId), isNull(skill.archivedAt))
    )
    .limit(1);
  const version = row[0];
  if (!version) return null;

  const assetName = version.assetName;
  const manifest = parseManifest(version.manifest);
  const bundlePrefix = bundlePrefixFromEntrypoint(manifest.entrypointPath);
  const readable = [...manifest.files]
    .filter((file) => file.promptReadable)
    .sort((a, b) => {
      if (a.path === manifest.entrypointPath) return -1;
      if (b.path === manifest.entrypointPath) return 1;
      return a.path.localeCompare(b.path);
    });

  const sections = [
    `Skill bundle: ${version.skillName} v${version.version}`,
    `Entrypoint: ${version.entrypointPath}`,
  ];

  for (const file of readable) {
    const stripped = stripBundlePrefix(file.path, bundlePrefix);
    const treePath =
      file.path === manifest.entrypointPath ? `${assetName}/SKILL.md` : `${assetName}/${stripped}`;
    const content = await readSkillFile(repoStore, version.assetId, treePath);
    if (!content) continue;
    sections.push(`--- file: ${file.path} ---\n${content.toString('utf8')}`);
  }

  const assets = manifest.files.filter((file) => !file.promptReadable);
  if (assets.length > 0) {
    sections.push(
      `Stored-only assets (not executed or injected):\n${assets.map((file) => `- ${file.path} (${file.mimeType}, ${file.size} bytes)`).join('\n')}`
    );
  }
  return sections.join('\n\n');
}

export async function getSkillVersionPreview(
  db: HubDb,
  repoStore: RepoStore,
  tenantId: string,
  versionId: string
): Promise<{ version: SkillVersionView; files: Array<{ path: string; content?: string }> } | null> {
  const rows = await db
    .select({ row: skillVersion, assetName: skillVersion.assetName })
    .from(skillVersion)
    .innerJoin(skill, eq(skill.id, skillVersion.skillId))
    .where(
      and(eq(skillVersion.id, versionId), eq(skill.tenantId, tenantId), isNull(skill.archivedAt))
    )
    .limit(1);
  const entry = rows[0];
  if (!entry) return null;

  const { row, assetName } = entry;
  const manifest = parseManifest(row.manifest);
  const bundlePrefix = bundlePrefixFromEntrypoint(manifest.entrypointPath);

  const files = await Promise.all(
    manifest.files.map(async (file) => {
      if (!file.promptReadable) return { path: file.path };
      const stripped = stripBundlePrefix(file.path, bundlePrefix);
      const treePath =
        file.path === manifest.entrypointPath
          ? `${assetName}/SKILL.md`
          : `${assetName}/${stripped}`;
      const content = await readSkillFile(repoStore, row.assetId, treePath);
      return { path: file.path, ...(content ? { content: content.toString('utf8') } : {}) };
    })
  );

  return { version: serializeVersion(row), files };
}
