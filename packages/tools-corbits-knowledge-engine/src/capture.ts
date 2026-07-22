import { createHash } from "node:crypto";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";
import {
  isRecord,
  knowledgeEngineFetchJSON,
  parseArgs,
  resolveConfig,
  stringTool,
  type KnowledgeEngineToolsConfig,
  type ResolvedKnowledgeEngineConfig,
} from "./shared";

/** Adapter name the engine records provenance under for agent-authored captures. */
const AGENT_CAPTURE_ADAPTER = "workbench-agent";

export const CaptureChunkArgsSchema = type({
  text: "string > 0",
  "role?": "string",
});

// Mirrors the engine's EntityHint (kind + identity key, optional label) — the
// engine rejects a bare string, so the tool must send the object shape.
export const CaptureEntityHintArgsSchema = type({
  kind: "string > 0",
  identifier: "string > 0",
  "label?": "string",
});

// Mirrors the engine's KnowledgeEdgeHint: a relation from the captured document
// (implicit "from") to a document/entity/native ref.
export const CaptureEdgeArgsSchema = type({
  rel: "'about'|'produced_by'|'links'|'parent'|'mentions'|'waiting_on'",
  to: {
    type: "'document'|'entity'|'native'",
    ref: "string > 0",
  },
});

export const CaptureArgsSchema = type({
  kind: "string > 0",
  title: "string > 0",
  externalRef: "string > 0",
  "text?": "string > 0",
  "chunks?": CaptureChunkArgsSchema.array().atLeastLength(1),
  "entityHints?": CaptureEntityHintArgsSchema.array(),
  "edges?": CaptureEdgeArgsSchema.array(),
  "visibilityMode?": "'tenant'|'principals'|'source_acl'|'private'",
  "visibilityPrincipalIds?": "string[]",
  "sourceClass?": "'native'|'thread'|'channel'|'call'|'record'",
});

export type CaptureArgs = typeof CaptureArgsSchema.infer;

const CaptureResponseSchema = type({
  document_id: "string",
  version_id: "string",
  chunks: "number",
  status: "string",
});

export type KnowledgeCaptureResult = {
  documentId: string;
  versionId: string;
  chunks: number;
  status: string;
};

type CaptureChunkPayload = {
  ordinal: number;
  text: string;
  role?: string;
};

function resolveChunks(args: CaptureArgs): CaptureChunkPayload[] {
  if (args.chunks !== undefined) {
    return args.chunks.map((chunk, ordinal) => ({
      ordinal,
      text: chunk.text,
      ...(chunk.role !== undefined ? { role: chunk.role } : {}),
    }));
  }
  if (args.text !== undefined) {
    return [{ ordinal: 0, text: args.text }];
  }
  throw new Error(
    "capture_to_knowledge: one of `text` or `chunks` is required",
  );
}

function computeContentHash(chunks: readonly CaptureChunkPayload[]): string {
  const digestInput = chunks.map((chunk) => chunk.text).join("\n\n");
  return createHash("sha256").update(digestInput, "utf8").digest("hex");
}

async function capture(
  config: ResolvedKnowledgeEngineConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<KnowledgeCaptureResult> {
  const args = parseArgs(CaptureArgsSchema, rawArgs, "capture_to_knowledge");
  const chunks = resolveChunks(args);

  const document: Record<string, unknown> = {
    kind: args.kind,
    title: args.title,
    externalRef: args.externalRef,
    visibility: {
      mode: args.visibilityMode ?? "tenant",
      ...(args.visibilityPrincipalIds !== undefined
        ? { principalIds: args.visibilityPrincipalIds }
        : {}),
    },
    entityHints: args.entityHints ?? [],
    ...(args.edges !== undefined ? { edges: args.edges } : {}),
    chunks,
    actor: {
      kind: "agent",
      ...(config.principalId != null
        ? { principalId: config.principalId }
        : {}),
    },
    ...(args.sourceClass !== undefined
      ? { sourceClass: args.sourceClass }
      : {}),
    contentHash: computeContentHash(chunks),
  };

  const body = {
    tenant_id: config.tenantId,
    adapter: AGENT_CAPTURE_ADAPTER,
    occurred_at: new Date().toISOString(),
    document,
  };

  const response = await knowledgeEngineFetchJSON(
    config,
    { path: "/api/capture", body },
    signal,
  );

  if (!isRecord(response)) {
    throw new Error(
      "capture_to_knowledge: invalid engine response: expected an object",
    );
  }
  const parsed = CaptureResponseSchema(response);
  if (parsed instanceof type.errors) {
    throw new Error(
      `capture_to_knowledge: invalid engine response: ${parsed.summary}`,
    );
  }

  return {
    documentId: parsed.document_id,
    versionId: parsed.version_id,
    chunks: parsed.chunks,
    status: parsed.status,
  };
}

export const CAPTURE_TO_KNOWLEDGE_DEFINITION: ToolDefinition = {
  name: "capture_to_knowledge",
  description:
    "Capture a piece of evidence (a note, an excerpt, a finding) into the team's shared knowledge base so it becomes searchable via search_company_knowledge. Provide either `text` (captured as a single chunk) or `chunks` (pre-split passages, in order). Returns the resulting document's id, version id, chunk count, and ingest status.",
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        description: "The document kind (e.g. 'call-note', 'doc', 'finding').",
      },
      title: { type: "string", description: "A human-readable title." },
      externalRef: {
        type: "string",
        description:
          "A stable external reference for this document (e.g. a URL, a call id) — used to dedupe and to link back to the source.",
      },
      text: {
        type: "string",
        description:
          "The full text to capture, when it does not need to be pre-split. Captured as a single chunk.",
      },
      chunks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            role: {
              type: "string",
              description:
                "Optional role for this chunk (e.g. 'speaker:alice', 'summary').",
            },
          },
          required: ["text"],
        },
        description:
          "Pre-split passages, in order. Use instead of `text` when the source already has natural chunk boundaries (e.g. transcript turns).",
      },
      entityHints: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              description: "Entity kind (e.g. 'person', 'org').",
            },
            identifier: {
              type: "string",
              description: "Identity key (e.g. an email or a domain).",
            },
            label: {
              type: "string",
              description: "Optional human-readable label.",
            },
          },
          required: ["kind", "identifier"],
        },
        description:
          "Optional entities (people, companies) this document relates to, to aid downstream linking.",
      },
      edges: {
        type: "array",
        items: {
          type: "object",
          properties: {
            rel: {
              type: "string",
              enum: [
                "about",
                "produced_by",
                "links",
                "parent",
                "mentions",
                "waiting_on",
              ],
              description: "Relationship kind.",
            },
            to: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["document", "entity", "native"],
                },
                ref: { type: "string" },
              },
              required: ["type", "ref"],
            },
          },
          required: ["rel", "to"],
        },
        description:
          "Optional explicit relationships from this document to other documents, entities, or native refs.",
      },
      visibilityMode: {
        type: "string",
        enum: ["tenant", "principals", "source_acl", "private"],
        description:
          "Visibility mode for the captured document. Defaults to 'tenant'.",
      },
      visibilityPrincipalIds: {
        type: "array",
        items: { type: "string" },
        description:
          "Principal ids allowed to see this document when visibilityMode is restrictive (e.g. 'private').",
      },
      sourceClass: {
        type: "string",
        enum: ["native", "thread", "channel", "call", "record"],
        description:
          "Optional authority class of the source (e.g. 'call', 'thread').",
      },
    },
    required: ["kind", "title", "externalRef"],
  },
};

export const CAPTURE_DEFINITIONS: ToolDefinition[] = [
  CAPTURE_TO_KNOWLEDGE_DEFINITION,
];

export function createCaptureTools(
  config: KnowledgeEngineToolsConfig,
): AgentTool[] {
  const resolved = resolveConfig(config);

  return [
    stringTool(CAPTURE_TO_KNOWLEDGE_DEFINITION, (args, signal) =>
      capture(resolved, args, signal),
    ),
  ];
}
