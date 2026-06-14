import type { AgentTool } from '@intx/agent';
import type { DB } from '@intx/db';
import type { ToolDefinition } from '@intx/types/runtime';
import { and, eq, max } from 'drizzle-orm';
import { artifact, artifactVersion } from '../db/schema';
import type { ContextToolEntry } from '../lib/tool-registry';

export const WRITE_ARTIFACT_DEFINITION: ToolDefinition = {
  name: 'write_artifact',
  description:
    'Create or update a Workbench artifact with body text and optional citations. Returns artifactId, version, and title.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Artifact title.' },
      body: { type: 'string', description: 'Full text body of the artifact.' },
      citations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            source: { type: 'string' },
            retrievedAt: { type: 'string' },
            title: { type: 'string' },
          },
          required: ['url', 'source', 'retrievedAt'],
        },
        description: 'Optional list of citations for this artifact.',
      },
      kind: {
        type: 'string',
        description: 'Artifact kind, e.g. report, email, memo, article.',
      },
    },
    required: ['title', 'body', 'kind'],
  },
};

type WriteArtifactContext = {
  db: DB['db'];
  tenantId: string;
  principalId: string;
  sessionId: string;
};

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

export function createWriteArtifactTool(context: WriteArtifactContext): AgentTool[] {
  return [
    {
      kind: 'string',
      definition: WRITE_ARTIFACT_DEFINITION,
      handler: async (args, _signal) => {
        const title = requireString(args, 'title');
        const body = requireString(args, 'body');
        const kind = requireString(args, 'kind');

        const rawCitations = args.citations;
        const citations = Array.isArray(rawCitations) ? rawCitations : [];

        const result = await context.db.transaction(async (tx) => {
          // artifact.sessionId is a uuid FK to workflow_run — not suitable for agent sessions.
          // Deduplicate by (principalId, title, kind) instead, which is stable across sessions.
          const existingRows = await tx
            .select({ id: artifact.id })
            .from(artifact)
            .where(
              and(
                eq(artifact.principalId, context.principalId),
                eq(artifact.title, title),
                eq(artifact.kind, kind)
              )
            )
            .limit(1);

          let artifactId: string;

          if (existingRows.length > 0 && existingRows[0]) {
            artifactId = existingRows[0].id;
          } else {
            const now = new Date();
            const [created] = await tx
              .insert(artifact)
              .values({
                tenantId: context.tenantId,
                principalId: context.principalId,
                kind,
                title,
                content: body,
                source: { citations } as Record<string, unknown>,
                status: 'draft',
                version: 1,
                createdAt: now,
                updatedAt: now,
              })
              .returning({ id: artifact.id });

            if (!created) {
              throw new Error('Failed to create artifact row');
            }
            artifactId = created.id;
          }

          const maxVersionResult = await tx
            .select({ maxVersion: max(artifactVersion.version) })
            .from(artifactVersion)
            .where(eq(artifactVersion.artifactId, artifactId));

          const previousMax = maxVersionResult[0]?.maxVersion ?? 0;
          const nextVersion = (previousMax ?? 0) + 1;

          await tx.insert(artifactVersion).values({
            artifactId,
            version: nextVersion,
            title,
            content: body,
            authorId: context.principalId,
            createdAt: new Date(),
          });

          return { artifactId, version: nextVersion };
        });

        return JSON.stringify({ artifactId: result.artifactId, version: result.version, title });
      },
    },
  ];
}

export const WRITE_ARTIFACT_HUB_TOOLS: Record<string, ContextToolEntry> = {
  write_artifact: {
    definition: WRITE_ARTIFACT_DEFINITION,
    createTools: (context) =>
      createWriteArtifactTool({
        db: context.db,
        tenantId: context.tenantId,
        principalId: context.principalId,
        sessionId: context.sessionId,
      }),
  },
};
