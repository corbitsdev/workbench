import type { AgentTool } from "@intx/agent";
import type { DB } from "@intx/db";
import { getLogger } from "@intx/log";
import { parseReport } from "@workbench/last30days-core";
import { WRITE_ARTIFACT_DEFINITION } from "@workbench/tools-artifact";
import { and, eq, max } from "drizzle-orm";
import { artifact, artifactVersion } from "../db/schema";
import type { ContextToolEntry } from "../lib/tool-registry";

const log = getLogger(["tools", "write-artifact"]);

export { WRITE_ARTIFACT_DEFINITION };

type WriteArtifactContext = {
  db: DB["db"];
  tenantId: string;
  principalId: string;
};

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

export function createWriteArtifactTool(
  context: WriteArtifactContext,
): AgentTool[] {
  return [
    {
      kind: "string",
      definition: WRITE_ARTIFACT_DEFINITION,
      handler: async (args, _signal) => {
        const title = requireString(args, "title");
        const body = requireString(args, "body");
        const kind = requireString(args, "kind");

        let citations = Array.isArray(args.citations) ? args.citations : [];

        let brief: Record<string, unknown> | undefined;
        const rawData = args.data;
        if (
          typeof rawData === "object" &&
          rawData !== null &&
          !Array.isArray(rawData)
        ) {
          brief = rawData as Record<string, unknown>;
        }

        const rawBriefContent = args.content;
        if (
          typeof rawBriefContent === "string" &&
          rawBriefContent.trim().length > 0
        ) {
          try {
            const parsedBrief = parseReport(JSON.parse(rawBriefContent));
            if (parsedBrief !== null) {
              brief = parsedBrief as unknown as Record<string, unknown>;
              if (citations.length === 0) {
                citations = parsedBrief.citations;
              }
            } else {
              log.warn(
                "write_artifact brief content is JSON but does not match the Report schema; ignoring",
                { title },
              );
            }
          } catch (cause) {
            // Explicit citations/data still apply, but a malformed brief here
            // means an upstream step produced bad content — surface it.
            log.warn(
              "write_artifact brief content is not valid JSON; ignoring",
              {
                title,
                error: cause instanceof Error ? cause.message : cause,
              },
            );
          }
        }

        const source: Record<string, unknown> =
          brief === undefined
            ? { origin: "workflow", citations }
            : { origin: "workflow", citations, brief };
        // Optional display name for the gallery tile of a session-less workflow
        // artifact. The workflow chooses the string; the artifact layer stays
        // generic (no workflow-specific label baked into the UI package).
        if (typeof args.jobLabel === "string" && args.jobLabel.trim() !== "") {
          source.jobLabel = args.jobLabel.trim();
        }

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
                eq(artifact.kind, kind),
              ),
            )
            .limit(1)
            // Lock the matched row so two concurrent writes (e.g. a synthesis
            // retry) cannot both read the same max version and insert dupes.
            .for("update");

          const existingId =
            existingRows.length > 0 ? existingRows[0]?.id : undefined;
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
                status: "draft",
                version: 1,
                createdAt: now,
                updatedAt: now,
              })
              .returning({ id: artifact.id });

            if (!created) {
              throw new Error("Failed to create artifact row");
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
              .set({
                content: body,
                source,
                version: nextVersion,
                updatedAt: now,
              })
              .where(eq(artifact.id, artifactId));
          }

          return { artifactId, version: nextVersion };
        });

        return JSON.stringify({
          artifactId: result.artifactId,
          version: result.version,
          title,
        });
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
