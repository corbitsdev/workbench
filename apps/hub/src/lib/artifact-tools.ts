import type { AgentTool } from '@intx/agent';
import type { DB } from '@intx/db';
import type { ToolDefinition } from '@intx/types/runtime';
import { artifact, artifactVersion } from '../db/schema';

export const ARTIFACT_LINK_FILE_DEFINITION: ToolDefinition = {
  name: 'artifact_link_file',
  description:
    'Create a Workbench artifact row linked to a file in the agent workspace. Call this after writing the file with write_file.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Artifact title.' },
      kind: { type: 'string', description: 'Artifact kind, such as document, email, memo, article, essay, or letter.' },
      path: { type: 'string', description: 'Relative path to the file in the agent workspace.' },
      preview: { type: 'string', description: 'Optional short preview shown before the file is opened.' },
    },
    required: ['title', 'kind', 'path'],
  },
};

type ArtifactToolContext = {
  db: DB['db'];
  tenantId: string;
  principalId: string;
  agentId: string;
  sessionId: string;
};

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

export function createArtifactTools(context: ArtifactToolContext): AgentTool[] {
  return [
    {
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
        const now = new Date();

        const row = await context.db.transaction(async (tx) => {
          const [created] = await tx
            .insert(artifact)
            .values({
              tenantId: context.tenantId,
              principalId: context.principalId,
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

        return JSON.stringify({ artifactId: row.id, title, kind, path }, null, 2);
      },
    },
  ];
}

export const ARTIFACT_HUB_TOOLS = {
  artifact_link_file: {
    definition: ARTIFACT_LINK_FILE_DEFINITION,
    createTools: createArtifactTools,
  },
};
