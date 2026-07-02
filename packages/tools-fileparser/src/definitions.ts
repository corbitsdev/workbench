import type { ToolDefinition } from "@intx/types/runtime";

// The parse_file tool gives any agent — regardless of whether its own model can
// read documents — a way to reason over a PDF or image artifact. The artifact
// may be a user upload or a file pulled from another source (Attio, Granola,
// Linear); either way the agent passes its id here and the hub runs a
// doc-capable (Anthropic) parse turn and returns the extracted text. It is for
// binary files only — content that is already text must be read directly.
export const PARSE_FILE_DEFINITION: ToolDefinition = {
  name: "parse_file",
  description:
    "Extract the text from a PDF or image artifact you cannot read directly. Returns the extracted text; optionally pass instructions to pull only what you need (e.g. 'list every action item'). Use it for binary files only, whether uploaded by the user or fetched from another source. Do not use it on content that is already text — notes, transcripts, tool outputs, or artifacts written by an agent; read those directly with artifact_read.",
  inputSchema: {
    type: "object",
    properties: {
      artifactId: {
        type: "string",
        description:
          "The id of the file artifact to parse (from the attachment reference in the conversation).",
      },
      instructions: {
        type: "string",
        description:
          "Optional. A specific extraction directive, e.g. 'summarize', 'extract the pricing table', 'list all dates'. Omit to get a full faithful transcription.",
      },
    },
    required: ["artifactId"],
  },
};

export const FILEPARSER_TOOL_DEFINITIONS: ToolDefinition[] = [
  PARSE_FILE_DEFINITION,
];
