import type { AgentTool } from "@intx/agent";
import { resolveCredentialRequirement } from "@intx/db";
import {
  deployStaticFilesToVercel,
  VERCEL_DEPLOY_ARTIFACT_DEFINITION,
} from "@workbench/tools-vercel";
import { type } from "arktype";
import { and, eq } from "drizzle-orm";
import {
  expandWebArtifactToVercelFiles,
  WEB_ARTIFACT_KIND,
  WEB_SITE_KIND,
} from "@workbench/shared";
import type { HubDb } from "../db";
import { artifact, artifactVersion } from "../db/schema";
import type { ContextToolEntry } from "../lib/tool-registry";
import { decryptToolCredentialSecret } from "../lib/credential-crypto";

const DeployArtifactArgs = type({
  artifactId: "string > 0",
  projectName: "string > 0",
  "teamId?": "string > 0",
  "target?": "'production' | 'preview'",
  "version?": "number.integer > 0",
});

export type VercelDeployArtifactContext = {
  db: HubDb;
  tenantId: string;
};

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function loadArtifactContent(
  db: HubDb,
  tenantId: string,
  artifactId: string,
  version: number | undefined,
): Promise<{ kind: string; content: string; version: number }> {
  const [row] = await db
    .select()
    .from(artifact)
    .where(and(eq(artifact.id, artifactId), eq(artifact.tenantId, tenantId)))
    .limit(1);

  if (!row) {
    throw new Error(`Artifact not found: ${artifactId}`);
  }

  if (version === undefined) {
    return { kind: row.kind, content: row.content, version: row.version };
  }

  const [versionRow] = await db
    .select()
    .from(artifactVersion)
    .where(
      and(
        eq(artifactVersion.artifactId, artifactId),
        eq(artifactVersion.version, version),
      ),
    )
    .limit(1);

  if (!versionRow) {
    throw new Error(`Version ${version} not found for artifact ${artifactId}`);
  }

  return {
    kind: row.kind,
    content: versionRow.content,
    version: versionRow.version,
  };
}

export function createVercelDeployArtifactTools(
  context: VercelDeployArtifactContext,
): AgentTool[] {
  return [
    {
      kind: "string",
      definition: VERCEL_DEPLOY_ARTIFACT_DEFINITION,
      handler: async (args, signal) => {
        const parsed = DeployArtifactArgs(args);
        if (parsed instanceof type.errors) {
          throw new Error(`vercel_deploy_artifact: ${parsed.summary}`);
        }

        const loaded = await loadArtifactContent(
          context.db,
          context.tenantId,
          parsed.artifactId,
          parsed.version,
        );

        if (
          loaded.kind !== WEB_ARTIFACT_KIND &&
          loaded.kind !== WEB_SITE_KIND
        ) {
          throw new Error(
            `Artifact ${parsed.artifactId} is kind "${loaded.kind}"; only web and web_site can be deployed`,
          );
        }

        const files = expandWebArtifactToVercelFiles(
          loaded.kind,
          loaded.content,
        );

        let resolved: Awaited<ReturnType<typeof resolveCredentialRequirement>>;
        try {
          resolved = await resolveCredentialRequirement(
            context.db,
            context.tenantId,
            { providerName: "vercel", source: "tenant" },
            null,
            null,
          );
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "credential resolution failed";
          throw new Error(
            `Vercel credential could not be resolved: ${message}`,
          );
        }
        if (!resolved) {
          throw new Error("No credential configured for provider: vercel");
        }

        const providerRow = await context.db.query.provider.findFirst({
          where: (p, { eq }) => eq(p.id, resolved.providerId),
        });
        const metadata = (providerRow?.metadata ?? {}) as { baseURL?: string };

        const vercelConfig: { apiKey: string; baseUrl?: string } = {
          apiKey: decryptToolCredentialSecret(resolved.secret),
        };
        if (metadata.baseURL !== undefined) {
          vercelConfig.baseUrl = metadata.baseURL;
        }

        const deployInput: {
          projectName: string;
          files: { path: string; content: string }[];
          teamId?: string;
          target?: "production" | "preview";
        } = {
          projectName: parsed.projectName,
          files,
        };
        if (parsed.teamId !== undefined) {
          deployInput.teamId = parsed.teamId;
        }
        if (parsed.target !== undefined) {
          deployInput.target = parsed.target;
        }

        const deployment = await deployStaticFilesToVercel(
          vercelConfig,
          deployInput,
          signal,
        );

        return jsonResult({
          artifactId: parsed.artifactId,
          artifactVersion: loaded.version,
          artifactKind: loaded.kind,
          fileCount: files.length,
          deployment,
        });
      },
    },
  ];
}

export const VERCEL_DEPLOY_ARTIFACT_HUB_TOOLS: Record<
  string,
  ContextToolEntry
> = {
  vercel_deploy_artifact: {
    sideEffect: "write",
    definition: VERCEL_DEPLOY_ARTIFACT_DEFINITION,
    createTools: (ctx) =>
      createVercelDeployArtifactTools({
        db: ctx.db,
        tenantId: ctx.tenantId,
      }),
  },
};
