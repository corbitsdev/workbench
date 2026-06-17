import type { AgentTool } from '@intx/agent';
import type { DB } from '@intx/db';
import { schema as intxSchema } from '@intx/db';
import type { ToolDefinition } from '@intx/types/runtime';
import { and, desc, eq } from 'drizzle-orm';
import { artifact, artifactStatus, artifactVersion, memberAgentInstance } from '../db/schema';

type ArtifactStatus = (typeof artifactStatus)[number];

export const ARTIFACT_LINK_FILE_DEFINITION: ToolDefinition = {
  name: 'artifact_link_file',
  description:
    'Create a Workbench artifact row linked to a file in the agent workspace. Call this after writing the file with write_file.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Artifact title.' },
      kind: {
        type: 'string',
        description: 'Artifact kind, such as document, email, memo, article, essay, or letter.',
      },
      path: {
        type: 'string',
        description: 'Relative path to the file in the agent workspace.',
      },
      preview: {
        type: 'string',
        description: 'Optional short preview shown before the file is opened.',
      },
    },
    required: ['title', 'kind', 'path'],
  },
};

export const ARTIFACT_CREATE_DEFINITION: ToolDefinition = {
  name: 'artifact_create',
  description:
    'Create a new Workbench artifact with inline content. Use this to save a document, note, draft, or other written output directly. Returns the artifact id and version. Revise it later with artifact_write.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Artifact title.' },
      kind: {
        type: 'string',
        description: 'Artifact kind, such as document, email, memo, article, essay, or note.',
      },
      content: {
        type: 'string',
        description: 'The full text content of the artifact.',
      },
    },
    required: ['title', 'kind', 'content'],
  },
};

export const ARTIFACT_READ_DEFINITION: ToolDefinition = {
  name: 'artifact_read',
  description:
    'Read a Workbench artifact by id. Returns its title, kind, status, current version, and content. Pass version to read a specific past version.',
  inputSchema: {
    type: 'object',
    properties: {
      artifactId: { type: 'string', description: 'The artifact id to read.' },
      version: {
        type: 'number',
        description: 'Optional specific version to read. Defaults to the latest version.',
      },
      tenantId: {
        type: 'string',
        description:
          "Optional tenant the artifact lives in. Defaults to the agent's own tenant. Pass this when the artifact was created in a different tenant (e.g. the shared org workbench vs a personal workbench).",
      },
    },
    required: ['artifactId'],
  },
};

export const ARTIFACT_WRITE_DEFINITION: ToolDefinition = {
  name: 'artifact_write',
  description:
    'Revise an existing Workbench artifact, saving the change as a new version. Provide content and/or title; omitted fields keep their current value. Returns the new version number.',
  inputSchema: {
    type: 'object',
    properties: {
      artifactId: { type: 'string', description: 'The artifact id to revise.' },
      content: {
        type: 'string',
        description: 'New content. Omit to keep the current content.',
      },
      title: {
        type: 'string',
        description: 'New title. Omit to keep the current title.',
      },
    },
    required: ['artifactId'],
  },
};

export const ARTIFACT_LINK_PRESENTATION_DEFINITION: ToolDefinition = {
  name: 'artifact_link_presentation',
  description:
    "Save a Gamma presentation as a Workbench artifact. Pass the Gamma URL as 'url', a 'title', and optionally an existing 'artifactId' to create a new version instead of a new artifact. Returns { artifactId, version, url }.",
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The Gamma share URL.' },
      title: { type: 'string', description: 'Artifact title.' },
      artifactId: {
        type: 'string',
        description:
          'If provided, creates a new version of this artifact. If absent, creates a new artifact with kind=presentation.',
      },
    },
    required: ['url', 'title'],
  },
};

export const ARTIFACT_FIND_BY_TITLE_DEFINITION: ToolDefinition = {
  name: 'artifact_find_by_title',
  description:
    'Find a Workbench artifact by exact title and optional kind. Returns { artifactId, version } if found, null if not found.',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Exact artifact title to search for.',
      },
      kind: { type: 'string', description: 'Optional kind filter.' },
    },
    required: ['title'],
  },
};

export const ARTIFACT_LIST_DEFINITION: ToolDefinition = {
  name: 'artifact_list',
  description:
    'List Workbench artifacts in this workbench, most recently updated first. Returns id, title, kind, status, version, and updatedAt for each. Optionally filter by kind or status.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', description: 'Optional kind filter.' },
      status: {
        type: 'string',
        description: 'Optional status filter: draft, approved, or rejected.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of artifacts to return (1-100, default 20).',
      },
    },
    required: [],
  },
};

type ArtifactToolContext = {
  db: DB['db'];
  tenantId: string;
  principalId: string;
  agentId: string;
  sessionId: string;
};

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function optionalNonEmptyString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${key} must not be empty`);
  }
  return trimmed;
}

function optionalStatus(args: Record<string, unknown>): ArtifactStatus | undefined {
  const value = optionalString(args, 'status');
  if (value === undefined) return undefined;
  if (!artifactStatus.includes(value as ArtifactStatus)) {
    throw new Error(`status must be one of: ${artifactStatus.join(', ')}`);
  }
  return value as ArtifactStatus;
}

function optionalVersion(args: Record<string, unknown>): number | undefined {
  const value = args.version;
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error('version must be a positive integer');
  }
  return value;
}

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function assertSessionContext(context: ArtifactToolContext): void {
  if (typeof context.sessionId !== 'string' || context.sessionId.length === 0) {
    throw new Error('session context is required');
  }
}

function createLinkFileHandler(context: ArtifactToolContext): AgentTool {
  return {
    kind: 'string',
    definition: ARTIFACT_LINK_FILE_DEFINITION,
    handler: async (args) => {
      const title = requiredString(args, 'title');
      const kind = requiredString(args, 'kind');
      const path = requiredString(args, 'path');
      const preview = typeof args.preview === 'string' ? args.preview.trim() : '';
      const content = preview || `Linked file: ${path}`;
      const source = {
        type: 'posix_file',
        path,
        agentId: context.agentId,
        sessionId: context.sessionId,
      };
      assertSessionContext(context);
      const now = new Date();
      const ownerMemberId = await resolveOwnerMemberPrincipalId(context.db, context);

      const row = await context.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(artifact)
          .values({
            tenantId: context.tenantId,
            principalId: context.principalId,
            ownerPrincipalId: ownerMemberId ?? null,
            sessionId: null,
            kind,
            title,
            content,
            source,
            status: 'draft',
            version: 1,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        if (!created) throw new Error('Failed to create artifact');

        await tx.insert(artifactVersion).values({
          artifactId: created.id,
          version: 1,
          title,
          content,
          authorId: context.principalId,
          createdAt: now,
        });

        return created;
      });

      return jsonResult({ artifactId: row.id, title, kind, path });
    },
  };
}

function createCreateHandler(context: ArtifactToolContext): AgentTool {
  return {
    kind: 'string',
    definition: ARTIFACT_CREATE_DEFINITION,
    handler: async (args) => {
      const title = requiredString(args, 'title');
      const kind = requiredString(args, 'kind');
      const content = requiredString(args, 'content');
      const source = {
        type: 'inline',
        agentId: context.agentId,
        sessionId: context.sessionId,
      };
      assertSessionContext(context);
      const now = new Date();
      const ownerMemberId = await resolveOwnerMemberPrincipalId(context.db, context);

      const row = await context.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(artifact)
          .values({
            tenantId: context.tenantId,
            principalId: context.principalId,
            ownerPrincipalId: ownerMemberId ?? null,
            sessionId: null,
            kind,
            title,
            content,
            source,
            status: 'draft',
            version: 1,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        if (!created) throw new Error('Failed to create artifact');

        await tx.insert(artifactVersion).values({
          artifactId: created.id,
          version: 1,
          title,
          content,
          authorId: context.principalId,
          createdAt: now,
        });

        return created;
      });

      return jsonResult({ artifactId: row.id, title, kind, version: 1 });
    },
  };
}

/**
 * Resolve the human member principal id (`memberPrincipalId`) that owns
 * the agent identified by the tool context. Returns null when the agent
 * has no owning member (e.g. a system agent).
 *
 * Walks: context.principalId -> agent_instance -> member_agent_instance
 */
async function resolveOwnerMemberPrincipalId(
  db: DB['db'],
  context: { tenantId: string; principalId: string }
): Promise<string | null> {
  const instanceRows = await db
    .select({ id: intxSchema.agentInstance.id })
    .from(intxSchema.agentInstance)
    .where(
      and(
        eq(intxSchema.agentInstance.tenantId, context.tenantId),
        eq(intxSchema.agentInstance.principalId, context.principalId)
      )
    )
    .limit(1);
  const instanceId = instanceRows[0]?.id;
  if (!instanceId) return null;

  const ownerRows = await db
    .select({ memberPrincipalId: memberAgentInstance.memberPrincipalId })
    .from(memberAgentInstance)
    .where(
      and(
        eq(memberAgentInstance.tenantId, context.tenantId),
        eq(memberAgentInstance.instanceId, instanceId)
      )
    )
    .limit(1);
  return ownerRows[0]?.memberPrincipalId ?? null;
}

// Verify the agent's owning user is an active member of targetTenantId.
// Walks: agent instance -> member_agent_instance -> owner principal -> refId ->
// principal in target tenant. Fails closed (returns false) at any missing step.
async function ownerIsMemberOfTenant(
  db: DB['db'],
  context: { tenantId: string; principalId: string },
  targetTenantId: string
): Promise<boolean> {
  const ownerPrincipalId = await resolveOwnerMemberPrincipalId(db, context);
  if (!ownerPrincipalId) return false;

  const refIdRows = await db
    .select({ refId: intxSchema.principal.refId })
    .from(intxSchema.principal)
    .where(eq(intxSchema.principal.id, ownerPrincipalId))
    .limit(1);
  const userRefId = refIdRows[0]?.refId;
  if (!userRefId) return false;

  const membershipRows = await db
    .select({ id: intxSchema.principal.id })
    .from(intxSchema.principal)
    .where(
      and(
        eq(intxSchema.principal.tenantId, targetTenantId),
        eq(intxSchema.principal.kind, 'user'),
        eq(intxSchema.principal.refId, userRefId),
        eq(intxSchema.principal.status, 'active')
      )
    )
    .limit(1);
  return membershipRows.length > 0;
}

function createReadHandler(context: ArtifactToolContext): AgentTool {
  return {
    kind: 'string',
    definition: ARTIFACT_READ_DEFINITION,
    handler: async (args) => {
      const artifactId = requiredString(args, 'artifactId');
      const version = optionalVersion(args);
      const tenantId = optionalString(args, 'tenantId') ?? context.tenantId;

      if (tenantId !== context.tenantId) {
        const allowed = await ownerIsMemberOfTenant(context.db, context, tenantId);
        if (!allowed) throw new Error(`Artifact not found: ${artifactId}`);
      }

      const [row] = await context.db
        .select()
        .from(artifact)
        .where(and(eq(artifact.id, artifactId), eq(artifact.tenantId, tenantId)))
        .limit(1);

      if (!row) throw new Error(`Artifact not found: ${artifactId}`);

      if (version === undefined) {
        return jsonResult({
          artifactId: row.id,
          title: row.title,
          kind: row.kind,
          status: row.status,
          version: row.version,
          content: row.content,
        });
      }

      const [versionRow] = await context.db
        .select()
        .from(artifactVersion)
        .where(
          and(eq(artifactVersion.artifactId, artifactId), eq(artifactVersion.version, version))
        )
        .limit(1);

      if (!versionRow) {
        throw new Error(`Version ${version} not found for artifact ${artifactId}`);
      }

      return jsonResult({
        artifactId: row.id,
        title: versionRow.title,
        kind: row.kind,
        status: row.status,
        version: versionRow.version,
        content: versionRow.content,
      });
    },
  };
}

function createWriteHandler(context: ArtifactToolContext): AgentTool {
  return {
    kind: 'string',
    definition: ARTIFACT_WRITE_DEFINITION,
    handler: async (args) => {
      const artifactId = requiredString(args, 'artifactId');
      const nextContent = optionalNonEmptyString(args, 'content');
      const nextTitle = optionalNonEmptyString(args, 'title');

      if (nextContent === undefined && nextTitle === undefined) {
        throw new Error('Provide content and/or title to revise the artifact');
      }

      const now = new Date();

      // Read, version-bump, and write inside one transaction with the artifact
      // row locked (FOR UPDATE), so concurrent writers serialize instead of both
      // computing the same next version (lost update / duplicate version row).
      return await context.db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(artifact)
          .where(and(eq(artifact.id, artifactId), eq(artifact.tenantId, context.tenantId)))
          .for('update')
          .limit(1);

        if (!existing) throw new Error(`Artifact not found: ${artifactId}`);

        const newVersion = existing.version + 1;
        const title = nextTitle ?? existing.title;
        const content = nextContent ?? existing.content;

        await tx
          .update(artifact)
          .set({ title, content, version: newVersion, updatedAt: now })
          .where(eq(artifact.id, artifactId));

        await tx.insert(artifactVersion).values({
          artifactId,
          version: newVersion,
          title,
          content,
          authorId: context.principalId,
          createdAt: now,
        });

        return jsonResult({ artifactId, version: newVersion, title });
      });
    },
  };
}

function validatePresentationUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('url must be a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('url must use HTTPS');
  }
}

function createLinkPresentationHandler(context: ArtifactToolContext): AgentTool {
  return {
    kind: 'string',
    definition: ARTIFACT_LINK_PRESENTATION_DEFINITION,
    handler: async (args) => {
      const url = requiredString(args, 'url');
      validatePresentationUrl(url);
      const title = requiredString(args, 'title');
      const artifactId = optionalNonEmptyString(args, 'artifactId');

      const now = new Date();

      if (artifactId !== undefined) {
        return await context.db.transaction(async (tx) => {
          const [existing] = await tx
            .select()
            .from(artifact)
            .where(and(eq(artifact.id, artifactId), eq(artifact.tenantId, context.tenantId)))
            .for('update')
            .limit(1);

          if (!existing) throw new Error(`Artifact not found: ${artifactId}`);
          if (existing.kind !== 'presentation') {
            throw new Error(`Artifact ${artifactId} is not a presentation artifact`);
          }

          const newVersion = existing.version + 1;

          await tx
            .update(artifact)
            .set({ title, content: url, version: newVersion, updatedAt: now })
            .where(eq(artifact.id, artifactId));

          await tx.insert(artifactVersion).values({
            artifactId,
            version: newVersion,
            title,
            content: url,
            authorId: context.principalId,
            createdAt: now,
          });

          return jsonResult({ artifactId, version: newVersion, url });
        });
      }

      const ownerMemberId = await resolveOwnerMemberPrincipalId(context.db, context);
      const source = {
        type: 'inline',
        agentId: context.agentId,
        sessionId: context.sessionId,
      };
      assertSessionContext(context);

      const row = await context.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(artifact)
          .values({
            tenantId: context.tenantId,
            principalId: context.principalId,
            ownerPrincipalId: ownerMemberId ?? null,
            sessionId: null,
            kind: 'presentation',
            title,
            content: url,
            source,
            status: 'draft',
            version: 1,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        if (!created) throw new Error('Failed to create artifact');

        await tx.insert(artifactVersion).values({
          artifactId: created.id,
          version: 1,
          title,
          content: url,
          authorId: context.principalId,
          createdAt: now,
        });

        return created;
      });

      return jsonResult({ artifactId: row.id, version: 1, url });
    },
  };
}

function createFindByTitleHandler(context: ArtifactToolContext): AgentTool {
  return {
    kind: 'string',
    definition: ARTIFACT_FIND_BY_TITLE_DEFINITION,
    handler: async (args) => {
      const title = requiredString(args, 'title');
      const kind = optionalString(args, 'kind');

      const conditions = [eq(artifact.tenantId, context.tenantId), eq(artifact.title, title)];
      if (kind !== undefined) conditions.push(eq(artifact.kind, kind));

      const [row] = await context.db
        .select({ id: artifact.id, version: artifact.version })
        .from(artifact)
        .where(and(...conditions))
        .orderBy(desc(artifact.updatedAt))
        .limit(1);

      if (!row) return jsonResult(null);

      return jsonResult({ artifactId: row.id, version: row.version });
    },
  };
}

function createListHandler(context: ArtifactToolContext): AgentTool {
  return {
    kind: 'string',
    definition: ARTIFACT_LIST_DEFINITION,
    handler: async (args) => {
      const kind = optionalString(args, 'kind');
      const status = optionalStatus(args);
      const rawLimit =
        typeof args.limit === 'number' && Number.isFinite(args.limit)
          ? args.limit
          : DEFAULT_LIST_LIMIT;
      const limit = Math.min(Math.max(1, Math.floor(rawLimit)), MAX_LIST_LIMIT);

      const conditions = [eq(artifact.tenantId, context.tenantId)];
      if (kind !== undefined) conditions.push(eq(artifact.kind, kind));
      if (status !== undefined) conditions.push(eq(artifact.status, status));

      const rows = await context.db
        .select({
          id: artifact.id,
          title: artifact.title,
          kind: artifact.kind,
          status: artifact.status,
          version: artifact.version,
          updatedAt: artifact.updatedAt,
        })
        .from(artifact)
        .where(and(...conditions))
        .orderBy(desc(artifact.updatedAt))
        .limit(limit);

      return jsonResult({ artifacts: rows });
    },
  };
}

export function createArtifactTools(context: ArtifactToolContext): AgentTool[] {
  return [
    createLinkFileHandler(context),
    createCreateHandler(context),
    createReadHandler(context),
    createWriteHandler(context),
    createListHandler(context),
    createLinkPresentationHandler(context),
    createFindByTitleHandler(context),
  ];
}

function artifactToolEntry(definition: ToolDefinition) {
  return { definition, createTools: createArtifactTools };
}

export const ARTIFACT_HUB_TOOLS = {
  artifact_link_file: artifactToolEntry(ARTIFACT_LINK_FILE_DEFINITION),
  artifact_create: artifactToolEntry(ARTIFACT_CREATE_DEFINITION),
  artifact_read: artifactToolEntry(ARTIFACT_READ_DEFINITION),
  artifact_write: artifactToolEntry(ARTIFACT_WRITE_DEFINITION),
  artifact_list: artifactToolEntry(ARTIFACT_LIST_DEFINITION),
  artifact_link_presentation: artifactToolEntry(ARTIFACT_LINK_PRESENTATION_DEFINITION),
  artifact_find_by_title: artifactToolEntry(ARTIFACT_FIND_BY_TITLE_DEFINITION),
};
