import type { AgentTool } from '@intx/agent';
import type { DB } from '@intx/db';
import { WRITE_ARTIFACT_DEFINITION } from '@workbench/tools-artifact';
import { and, eq, max } from 'drizzle-orm';
import { artifact, artifactVersion } from '../db/schema';
import type { ContextToolEntry } from '../lib/tool-registry';

export { WRITE_ARTIFACT_DEFINITION };

type WriteArtifactContext = {
  db: DB['db'];
  tenantId: string;
  principalId: string;
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

        const rawData = args.data;
        const brief =
          typeof rawData === 'object' && rawData !== null && !Array.isArray(rawData)
            ? (rawData as Record<string, unknown>)
            : undefined;
        const source: Record<string, unknown> =
          brief === undefined ? { citations } : { citations, brief };

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
            .limit(1)
            // Lock the matched row so two concurrent writes (e.g. a synthesis
            // retry) cannot both read the same max version and insert dupes.
            .for('update');

          const existingId = existingRows.length > 0 ? existingRows[0]?.id : undefined;
          const now = new Date();
          let artifactId: string;

          if (existingId !== undefined) {
            artifactId = existingId;
          } else {
            const [created] = await tx
              .insert(artifact)
              .values({
                tenantId: context.tenantId,
                principalId: context.principalId,
                sessionId: null,
                kind,
                title,
                content: body,
                source,
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

          const nextVersion = (maxVersionResult[0]?.maxVersion ?? 0) + 1;

          await tx.insert(artifactVersion).values({
            artifactId,
            version: nextVersion,
            title,
            content: body,
            authorId: context.principalId,
            createdAt: new Date(),
          });

          // On an update, the parent row is what the gallery/list renders, so it
          // must carry the latest content/source/version — otherwise re-running
          // research on the same topic accumulates versions while the UI is stuck
          // on v1's brief.
          if (existingId !== undefined) {
            await tx
              .update(artifact)
              .set({ content: body, source, version: nextVersion, updatedAt: now })
              .where(eq(artifact.id, artifactId));
          }

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
      }),
  },
};
