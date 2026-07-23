import type { ToolDefinition } from "@intx/types/runtime";
import type { ToolSideEffect } from "@workbench/tool-manifest";

type ArtifactToolDefinition = ToolDefinition & { sideEffect: ToolSideEffect };

export const ARTIFACT_LINK_FILE_DEFINITION: ArtifactToolDefinition = {
  name: "artifact_link_file",
  sideEffect: "write",
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

export const ARTIFACT_CREATE_DEFINITION: ArtifactToolDefinition = {
  name: "artifact_create",
  sideEffect: "write",
  description:
    "Create a new Workbench artifact with inline content. Use this to save a document, note, draft, or other written output directly. Returns the artifact id and version. Revise it later with artifact_write.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Artifact title." },
      kind: {
        type: "string",
        description:
          "Artifact kind, such as document, email, memo, article, essay, note, web for a single-file HTML artifact, or web_site for a multi-file static site stored as JSON { entry?, files: { path: content } }.",
      },
      content: {
        type: "string",
        description: "The full text content of the artifact.",
      },
    },
    required: ["title", "kind", "content"],
  },
};

export const ARTIFACT_READ_DEFINITION: ArtifactToolDefinition = {
  name: "artifact_read",
  sideEffect: "read",
  description:
    "Read a Workbench artifact by id. Returns its title, kind, current version, and content. Pass version to read a specific past version. When the content is too large to return at once, the result includes a 'continuation' field with instructions to read the rest with artifact_read_chunk.",
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
      path: {
        type: "string",
        description:
          "For kind=web_site only: return one file's content at this relative path. Without path, web_site reads return a summary (entry, file list, sizes) instead of the full bundle.",
      },
    },
    required: ["artifactId"],
  },
};

export const ARTIFACT_READ_CHUNK_DEFINITION: ArtifactToolDefinition = {
  name: "artifact_read_chunk",
  sideEffect: "read",
  description:
    "Read one bounded chunk of a Workbench artifact's content by character range. Use this to read a large artifact whose content did not fit in a single artifact_read: pass the offset named in the prior result's 'continuation' field, and keep calling with each new offset until the result has no 'continuation' field, which means you have reached the end. Not supported for kind=web_site — use artifact_read (summary or path) instead.",
  inputSchema: {
    type: "object",
    properties: {
      artifactId: { type: "string", description: "The artifact id to read." },
      offset: {
        type: "number",
        description:
          "Zero-based character offset to start reading from. Defaults to 0. Use the offset named in a prior result's 'continuation' field to read the next chunk.",
      },
      limit: {
        type: "number",
        description:
          "Maximum number of characters of content to return in this call. Defaults to a size that stays within the agent's tool-output budget.",
      },
      version: {
        type: "number",
        description:
          "Optional specific version to read. Defaults to the latest version.",
      },
      tenantId: {
        type: "string",
        description:
          "Optional tenant the artifact lives in. Defaults to the agent's own tenant.",
      },
    },
    required: ["artifactId"],
  },
};

export const ARTIFACT_WRITE_DEFINITION: ArtifactToolDefinition = {
  name: "artifact_write",
  sideEffect: "write",
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

export const ARTIFACT_LINK_PRESENTATION_DEFINITION: ArtifactToolDefinition = {
  name: "artifact_link_presentation",
  sideEffect: "write",
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

export const ARTIFACT_LINK_GAMMA_PRESENTATION_DEFINITION: ArtifactToolDefinition =
  {
    name: "artifact_link_gamma_presentation",
    sideEffect: "write",
    description:
      "Save a Gamma deck as a Workbench artifact of kind gamma_presentation. Pass the Gamma URL as 'url', a 'title', a short 'description' of the deck, and the 'gammaId'. Optionally pass an existing 'artifactId' to create a new version. Returns { artifactId, version, url }.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The Gamma share URL." },
        title: { type: "string", description: "Artifact title." },
        description: {
          type: "string",
          description: "A short description of what the deck is.",
        },
        gammaId: {
          type: "string",
          description: "The Gamma deck id.",
        },
        pdfUrl: {
          type: "string",
          description:
            "Optional temporary Gamma export URL for the deck PDF. When provided, the PDF is downloaded and stored durably so the artifact offers a PDF download.",
        },
        artifactId: {
          type: "string",
          description:
            "If provided, creates a new version of this artifact. If absent, creates a new artifact with kind=gamma_presentation.",
        },
      },
      required: ["url", "title", "description", "gammaId"],
    },
  };

export const ARTIFACT_FIND_BY_TITLE_DEFINITION: ArtifactToolDefinition = {
  name: "artifact_find_by_title",
  sideEffect: "read",
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

export const ARTIFACT_LIST_DEFINITION: ArtifactToolDefinition = {
  name: "artifact_list",
  sideEffect: "read",
  description:
    "List Workbench artifacts in this workbench, most recently updated first. Returns id, title, kind, version, and updatedAt for each. Optionally filter by kind.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", description: "Optional kind filter." },
      limit: {
        type: "number",
        description:
          "Maximum number of artifacts to return (1-100, default 20).",
      },
    },
    required: [],
  },
};

export const WRITE_ARTIFACT_DEFINITION: ArtifactToolDefinition = {
  name: "write_artifact",
  sideEffect: "write",
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
      sourceRef: {
        type: "string",
        description:
          "Optional stable origin key (e.g. granola:call:<noteId>). When set, re-writes with the same tenant+sourceRef return the existing artifactId instead of creating a second row.",
      },
      sourceRefPrefix: {
        type: "string",
        description:
          "Optional sourceRef namespace, joined server-side as `<sourceRefPrefix>-<sourceRefKey>`. For callers (e.g. workflow argMaps) that carry an item key but cannot concatenate strings. Requires sourceRefKey; ignored when sourceRef is set explicitly.",
      },
      sourceRefKey: {
        type: "string",
        description:
          "Optional per-item key joined with sourceRefPrefix into the artifact's sourceRef. Requires sourceRefPrefix.",
      },
      titlePrefix: {
        type: "string",
        description:
          "Optional prefix prepended verbatim to title (include any separator, e.g. 'Transcript — '). For callers that derive title from upstream data but cannot concatenate strings.",
      },
    },
    required: ["title", "body", "kind"],
  },
};

export const MEMORY_LOAD_DEFINITION: ArtifactToolDefinition = {
  name: "memory_load",
  sideEffect: "read",
  description:
    "Load your durable memory — the standing brief on the person you work for, durable facts and decisions, and contacts. Returns the full memory text (empty when nothing is stored yet). Call this when a task needs the context it holds, not on every turn.",
  inputSchema: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        description:
          "Memory scope. 'global' (default) is your durable memory, shared across every conversation. 'chat' (per-conversation memory) is not enabled yet.",
      },
    },
    required: [],
  },
};

export const MEMORY_SAVE_DEFINITION: ArtifactToolDefinition = {
  name: "memory_save",
  sideEffect: "write",
  description:
    "Save your durable memory, replacing the stored text with what you pass. Load it first, edit the whole text, then save the full result — saving overwrites, it does not append. Keep it organized under headings. Update only when you learn something durable, never for a greeting or simple reply.",
  inputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "The full memory text to store, replacing the prior text.",
      },
      scope: {
        type: "string",
        description:
          "Memory scope. 'global' (default) is your durable memory, shared across every conversation. 'chat' (per-conversation memory) is not enabled yet.",
      },
    },
    required: ["content"],
  },
};

export const ARTIFACT_TOOL_DEFINITIONS: ArtifactToolDefinition[] = [
  ARTIFACT_LINK_FILE_DEFINITION,
  ARTIFACT_CREATE_DEFINITION,
  ARTIFACT_READ_DEFINITION,
  ARTIFACT_READ_CHUNK_DEFINITION,
  ARTIFACT_WRITE_DEFINITION,
  ARTIFACT_LINK_PRESENTATION_DEFINITION,
  ARTIFACT_LINK_GAMMA_PRESENTATION_DEFINITION,
  ARTIFACT_FIND_BY_TITLE_DEFINITION,
  ARTIFACT_LIST_DEFINITION,
  WRITE_ARTIFACT_DEFINITION,
  MEMORY_LOAD_DEFINITION,
  MEMORY_SAVE_DEFINITION,
];
