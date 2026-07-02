import type { AgentTool } from "@intx/agent";
import { and, eq } from "drizzle-orm";
import { PARSE_FILE_DEFINITION } from "@workbench/tools-fileparser";
import { artifact } from "../db/schema";
import { parseDocument } from "../services/file-parser";
import type { ContextToolEntry } from "./tool-registry";
import type { HubDb } from "../db";

type FileParserToolContext = {
  db: HubDb;
  tenantId: string;
  principalId: string;
  agentId: string;
  sessionId: string;
};

const DATA_URL_RE = /^data:([^;,]+);base64,(.*)$/s;

// Binary files worth a parse turn: PDFs and images. Text-ish types (text/*,
// application/json) are already readable and must be read directly instead.
function isParseableFileMime(mimeType: string): boolean {
  return mimeType === "application/pdf" || mimeType.startsWith("image/");
}

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

      // parse_file only earns a doc-capable parse turn for binary files whose
      // bytes are not already readable text — a PDF or an image, whatever their
      // source (an upload, or a file pulled from Attio/Granola/Linear). Content
      // that is already text (a fetched note, a transcript, an agent-authored
      // artifact) must be read directly instead, so reject it before we spend a
      // parse turn. The discriminator is the content's MIME type, not its origin.
      const match = DATA_URL_RE.exec(row.content);
      const mimeType = match?.[1]?.split(";")[0]?.trim().toLowerCase();
      if (!match || !mimeType || !isParseableFileMime(mimeType)) {
        throw new Error(
          `Artifact ${artifactId} is not a binary file that needs parsing. Its content is already text — read it directly (e.g. with artifact_read) instead of parse_file.`,
        );
      }
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
