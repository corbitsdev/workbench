import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";

// Workflow-owned shaping tool: write_artifact needs `title` (parsed out of
// the raw granola_get_note note JSON's `title` field — a `fromJson` extract
// no native selector can express) and `body` (a straight rename of either
// `content`, the transcript stage's own note JSON, or `reply`, an agent
// step's output — also unrenamable by selectors). The two lineage runs
// (processed, persist) additionally need the SAME `noteId` duplicated under
// both `sourceRefKey` and `parentSourceRefKey`, which selectors cannot
// express either (no rename, no duplicate-under-two-keys). Kept private to
// process-granola-call rather than folded into the shared @workbench/
// tools-granola package, which other Granola workflows also depend on.
export const PROCESS_GRANOLA_PREPARE_DOCUMENT_DEFINITION: ToolDefinition = {
  name: "process_granola_prepare_document",
  description:
    "Internal process-granola-call workflow helper. Shapes one write_artifact document: extracts `title` from the raw granola_get_note JSON, picks `body` from `reply` (falling back to the raw note JSON for the transcript stage), and carries `noteId` as `sourceRefKey` (and, when includeParent is set, also as `parentSourceRefKey`).",
  inputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "The raw granola_get_note result JSON. Its `title` field becomes the document title; when `reply` is absent, this string is also the document body (the transcript stage).",
      },
      reply: {
        type: "string",
        description:
          "This stage's body text (an agent step's reply). Omit for the transcript stage.",
      },
      noteId: {
        type: "string",
        description:
          "The Granola note id. Carried through as this document's sourceRefKey.",
      },
      includeParent: {
        type: "boolean",
        description:
          "When true, also emits parentSourceRefKey (== noteId) for lineage to the prior artifact in the chain.",
      },
    },
    required: ["content", "noteId"],
  },
};

function coerceArgsObject(
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof args._raw === "string") {
    const parsed: unknown = JSON.parse(args._raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("_raw fallback is not a JSON object");
    }
    return parsed as Record<string, unknown>;
  }
  return args;
}

function extractTitle(content: string): string {
  const parsed: unknown = JSON.parse(content);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("content is not a JSON object");
  }
  const title = (parsed as Record<string, unknown>).title;
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new Error("note JSON has no title");
  }
  return title;
}

function createPrepareDocumentTool(): AgentTool {
  return {
    kind: "full",
    definition: PROCESS_GRANOLA_PREPARE_DOCUMENT_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const content = args.content;
      const noteId = args.noteId;
      if (typeof content !== "string" || content.trim().length === 0) {
        return {
          callId: call.id,
          isError: true,
          content: "content is required",
        };
      }
      if (typeof noteId !== "string" || noteId.trim().length === 0) {
        return {
          callId: call.id,
          isError: true,
          content: "noteId is required",
        };
      }

      let title: string;
      try {
        title = extractTitle(content);
      } catch (error) {
        return {
          callId: call.id,
          isError: true,
          content: error instanceof Error ? error.message : String(error),
        };
      }

      const reply = args.reply;
      const body =
        typeof reply === "string" && reply.trim().length > 0 ? reply : content;

      const result: Record<string, unknown> = {
        title,
        body,
        sourceRefKey: noteId,
      };
      if (args.includeParent === true) {
        result.parentSourceRefKey = noteId;
      }

      return { callId: call.id, content: result };
    },
  };
}

export function createProcessGranolaCallTools(): AgentTool[] {
  return [createPrepareDocumentTool()];
}
