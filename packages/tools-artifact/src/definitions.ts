import type { ToolDefinition } from "@intx/types/runtime";

export const ARTIFACT_LINK_FILE_DEFINITION: ToolDefinition = {
  name: "artifact_link_file",
  description:
    "Create a Workbench artifact row linked to a file in the agent workspace. Call this after writing the file with write_file.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Artifact title." },
      kind: {
        type: "string",
        description:
          "Artifact kind, such as document, email, memo, article, essay, or letter.",
      },
      path: {
        type: "string",
        description: "Relative path to the file in the agent workspace.",
      },
      preview: {
        type: "string",
        description: "Optional short preview shown before the file is opened.",
      },
    },
    required: ["title", "kind", "path"],
  },
};

export const ARTIFACT_CREATE_DEFINITION: ToolDefinition = {
  name: "artifact_create",
  description:
    "Create a new Workbench artifact with inline content. Use this to save a document, note, draft, or other written output directly. Returns the artifact id and version. Revise it later with artifact_write.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Artifact title." },
      kind: {
        type: "string",
        description:
          "Artifact kind, such as document, email, memo, article, essay, or note.",
      },
      content: {
        type: "string",
        description: "The full text content of the artifact.",
      },
    },
    required: ["title", "kind", "content"],
  },
};

export const ARTIFACT_READ_DEFINITION: ToolDefinition = {
  name: "artifact_read",
  description:
    "Read a Workbench artifact by id. Returns its title, kind, status, current version, and content. Pass version to read a specific past version.",
  inputSchema: {
    type: "object",
    properties: {
      artifactId: { type: "string", description: "The artifact id to read." },
      version: {
        type: "number",
        description:
          "Optional specific version to read. Defaults to the latest version.",
      },
      tenantId: {
        type: "string",
        description:
          "Optional tenant the artifact lives in. Defaults to the agent's own tenant. Pass this when the artifact was created in a different tenant (e.g. the shared org workbench vs a personal workbench).",
      },
    },
    required: ["artifactId"],
  },
};

export const ARTIFACT_WRITE_DEFINITION: ToolDefinition = {
  name: "artifact_write",
  description:
    "Revise an existing Workbench artifact, saving the change as a new version. Provide content and/or title; omitted fields keep their current value. Returns the new version number.",
  inputSchema: {
    type: "object",
    properties: {
      artifactId: { type: "string", description: "The artifact id to revise." },
      content: {
        type: "string",
        description: "New content. Omit to keep the current content.",
      },
      title: {
        type: "string",
        description: "New title. Omit to keep the current title.",
      },
    },
    required: ["artifactId"],
  },
};

export const ARTIFACT_LINK_PRESENTATION_DEFINITION: ToolDefinition = {
  name: "artifact_link_presentation",
  description:
    "Save a Gamma presentation as a Workbench artifact. Pass the Gamma URL as 'url', a 'title', and optionally an existing 'artifactId' to create a new version instead of a new artifact. Returns { artifactId, version, url }.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The Gamma share URL." },
      title: { type: "string", description: "Artifact title." },
      artifactId: {
        type: "string",
        description:
          "If provided, creates a new version of this artifact. If absent, creates a new artifact with kind=presentation.",
      },
    },
    required: ["url", "title"],
  },
};

export const ARTIFACT_FIND_BY_TITLE_DEFINITION: ToolDefinition = {
  name: "artifact_find_by_title",
  description:
    "Find a Workbench artifact by exact title and optional kind. Returns { artifactId, version } if found, null if not found.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Exact artifact title to search for.",
      },
      kind: { type: "string", description: "Optional kind filter." },
    },
    required: ["title"],
  },
};

export const ARTIFACT_LIST_DEFINITION: ToolDefinition = {
  name: "artifact_list",
  description:
    "List Workbench artifacts in this workbench, most recently updated first. Returns id, title, kind, status, version, and updatedAt for each. Optionally filter by kind or status.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", description: "Optional kind filter." },
      status: {
        type: "string",
        description: "Optional status filter: draft, approved, or rejected.",
      },
      limit: {
        type: "number",
        description:
          "Maximum number of artifacts to return (1-100, default 20).",
      },
    },
    required: [],
  },
};

export const WRITE_ARTIFACT_DEFINITION: ToolDefinition = {
  name: "write_artifact",
  description:
    "Create or update a Workbench artifact with body text and optional citations. Returns artifactId, version, and title.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Artifact title." },
      body: { type: "string", description: "Full text body of the artifact." },
      citations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            url: { type: "string" },
            source: { type: "string" },
            retrievedAt: { type: "string" },
            title: { type: "string" },
          },
          required: ["url", "source", "retrievedAt"],
        },
        description: "Optional list of citations for this artifact.",
      },
      kind: {
        type: "string",
        description:
          "Artifact kind, e.g. report, email, memo, article, research.",
      },
      data: {
        type: "object",
        description:
          "Optional structured payload for rich rendering (e.g. a research ResearchBrief). Stored under source.brief.",
      },
      jobLabel: {
        type: "string",
        description:
          "Optional display name for the gallery tile of a session-less workflow artifact (e.g. the producing workflow's name). Stored under source.jobLabel.",
      },
    },
    required: ["title", "body", "kind"],
  },
};

export const ARTIFACT_TOOL_DEFINITIONS: ToolDefinition[] = [
  ARTIFACT_LINK_FILE_DEFINITION,
  ARTIFACT_CREATE_DEFINITION,
  ARTIFACT_READ_DEFINITION,
  ARTIFACT_WRITE_DEFINITION,
  ARTIFACT_LINK_PRESENTATION_DEFINITION,
  ARTIFACT_FIND_BY_TITLE_DEFINITION,
  ARTIFACT_LIST_DEFINITION,
  WRITE_ARTIFACT_DEFINITION,
];
