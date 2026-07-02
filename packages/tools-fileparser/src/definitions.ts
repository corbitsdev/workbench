import type { ToolDefinition } from "@intx/types/runtime";

// The parse_file tool gives any agent — regardless of whether its own model can
// read documents — a way to reason over an uploaded PDF, document, or image. The
// file is uploaded and stored as a Workbench artifact; the agent passes that
// artifact id here and the hub runs a doc-capable (Anthropic) parse turn, then
// returns the extracted text.
export const PARSE_FILE_DEFINITION: ToolDefinition = {
  name: "parse_file",
  description:
    "Read an uploaded document, PDF, or image that was attached as a Workbench artifact and return its content as text. Use this whenever the user references an attached file you cannot read directly. Returns the parsed text. Optionally pass instructions to extract only what you need (e.g. 'list every action item').",
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
