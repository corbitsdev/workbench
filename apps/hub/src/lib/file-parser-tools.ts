import type { AgentTool } from "@intx/agent";
import type { DB } from "@intx/db";
import { and, eq } from "drizzle-orm";
import { PARSE_FILE_DEFINITION } from "@workbench/tools-fileparser";
import { artifact } from "../db/schema";
import { parseDocument } from "../services/file-parser";
import type { ContextToolEntry } from "./tool-registry";

type FileParserToolContext = {
  db: DB["db"];
  tenantId: string;
  principalId: string;
  agentId: string;
  sessionId: string;
};

const DATA_URL_RE = /^data:([^;,]+);base64,(.*)$/s;

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value.trim();
}

function createParseFileHandler(context: FileParserToolContext): AgentTool {
  return {
    kind: "string",
    definition: PARSE_FILE_DEFINITION,
    handler: async (args) => {
      const artifactId = requiredString(args, "artifactId");
      const instructions = optionalString(args, "instructions");

      const [row] = await context.db
        .select()
        .from(artifact)
        .where(
          and(
            eq(artifact.id, artifactId),
            eq(artifact.tenantId, context.tenantId),
          ),
        )
        .limit(1);
      if (!row) throw new Error(`Artifact not found: ${artifactId}`);

      const match = DATA_URL_RE.exec(row.content);
      if (!match) {
        throw new Error(
          `Artifact ${artifactId} is not a parseable file (expected a base64 data URL). Only uploaded files can be parsed.`,
        );
      }
      const mimeType = match[1]!;
      const bytes = new Uint8Array(Buffer.from(match[2]!, "base64"));

      return parseDocument(context.db, {
        tenantId: context.tenantId,
        traceId: artifactId,
        filename: row.title,
        mimeType,
        bytes,
        ...(instructions !== undefined ? { instructions } : {}),
      });
    },
  };
}

export const FILEPARSER_HUB_TOOLS: Record<string, ContextToolEntry> = {
  parse_file: {
    definition: PARSE_FILE_DEFINITION,
    createTools: (ctx) => [createParseFileHandler(ctx)],
  },
};
