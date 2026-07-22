import { type } from "arktype";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  GRANOLA_CALL_ARTIFACT_KINDS,
  GranolaCallSchema,
  buildCallAnalysisUserMessage,
  classifyCall,
  granolaCallArtifactTitle,
  granolaCallSourceRef,
  parseCallAnalysis,
  renderBriefContent,
  renderPainPointsContent,
  renderSummaryContent,
  type CallClassification,
  type GranolaCall,
} from "@workbench/shared";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

/** Prefer nested step-envelope `content` when present, else the outer record. */
function peelRecord(value: unknown): Record<string, unknown> | null {
  const outer = asRecord(parseMaybeJson(value));
  if (!outer) return null;
  if ("content" in outer) {
    const nested = asRecord(parseMaybeJson(outer.content));
    if (nested) return nested;
  }
  return outer;
}

function jsonResult(value: unknown): string {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// granola_normalize_note
// ---------------------------------------------------------------------------

export const GRANOLA_NORMALIZE_NOTE_DEFINITION: ToolDefinition = {
  name: "granola_normalize_note",
  description:
    "Normalize a raw Granola note (API shape or JSON string) into a typed GranolaCall for downstream workflow steps.",
  inputSchema: {
    type: "object",
    properties: {
      note: {
        description: "Raw Granola note object or JSON string.",
      },
      content: {
        description:
          "Optional envelope content when the step input is a tool result wrapper.",
      },
    },
  },
};

function readNoteBlob(args: Record<string, unknown>): unknown {
  if (args.note !== undefined) return parseMaybeJson(args.note);
  if (args.content !== undefined) return parseMaybeJson(args.content);
  if (args.id !== undefined) return args;
  return args;
}

function normalizeNotePayload(args: Record<string, unknown>): GranolaCall {
  const raw = readNoteBlob(args);
  const record = asRecord(raw) ?? {};
  const transcriptField = record.transcript;
  let transcriptText = "";
  if (typeof transcriptField === "string") {
    transcriptText = transcriptField;
  } else if (Array.isArray(transcriptField)) {
    transcriptText = transcriptField
      .map((item) => {
        const row = asRecord(item);
        return typeof row?.text === "string" ? row.text : "";
      })
      .filter((t) => t.length > 0)
      .join("\n");
  }

  const participantsRaw = record.participants;
  const participants = Array.isArray(participantsRaw)
    ? participantsRaw.filter((p): p is string => typeof p === "string")
    : [];

  const call = {
    id: typeof record.id === "string" ? record.id : "",
    title: typeof record.title === "string" ? record.title : "Untitled call",
    participants,
    createdAt:
      typeof record.created_at === "string"
        ? record.created_at
        : typeof record.createdAt === "string"
          ? record.createdAt
          : new Date().toISOString(),
    transcript: transcriptText,
    // GranolaCallSchema.summary is optional string (not null).
    ...(typeof record.summary === "string"
      ? { summary: record.summary }
      : typeof record.notes_markdown === "string"
        ? { summary: record.notes_markdown }
        : {}),
  };

  const validated = GranolaCallSchema(call);
  if (validated instanceof type.errors) {
    throw new Error(`granola_normalize_note: ${validated.summary}`);
  }
  return validated;
}

// ---------------------------------------------------------------------------
// granola_classify_call
// ---------------------------------------------------------------------------

export const GRANOLA_CLASSIFY_CALL_DEFINITION: ToolDefinition = {
  name: "granola_classify_call",
  description:
    "Classify a Granola call as internal, external, or unknown from participants + tenant domain. Missing domain → unknown (never skips).",
  inputSchema: {
    type: "object",
    properties: {
      participants: {
        type: "array",
        items: { type: "string" },
        description: "Participant emails or display names.",
      },
      tenantDomain: {
        type: "string",
        description:
          "Tenant email domain (e.g. acme.com). Empty/missing → unknown.",
      },
      note: {
        description:
          "Optional GranolaCall / note blob to read participants from.",
      },
      content: {
        description: "Optional envelope carrying participants or note.",
      },
    },
  },
};

function readParticipants(args: Record<string, unknown>): string[] {
  if (Array.isArray(args.participants)) {
    return args.participants.filter((p): p is string => typeof p === "string");
  }
  const note = peelRecord(args.note) ?? peelRecord(args.content);
  if (note && Array.isArray(note.participants)) {
    return note.participants.filter((p): p is string => typeof p === "string");
  }
  const peeled = peelRecord(args);
  if (peeled && Array.isArray(peeled.participants)) {
    return peeled.participants.filter(
      (p): p is string => typeof p === "string",
    );
  }
  return [];
}

function readTenantDomain(args: Record<string, unknown>): string {
  for (const key of ["tenantDomain", "domain"] as const) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  const envelope = peelRecord(args.content);
  if (envelope) {
    for (const key of ["tenantDomain", "domain"] as const) {
      const value = envelope[key];
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
  }
  // Empty domain is valid: classifyCall returns "unknown". Never throw —
  // optional argMap skip would otherwise drop the whole classify step.
  return "";
}

function classifyCallPayload(args: Record<string, unknown>): {
  classification: CallClassification;
} {
  return {
    classification: classifyCall(
      readParticipants(args),
      readTenantDomain(args),
    ),
  };
}

// ---------------------------------------------------------------------------
// granola_build_analysis_prompt
// ---------------------------------------------------------------------------

export const GRANOLA_BUILD_ANALYSIS_PROMPT_DEFINITION: ToolDefinition = {
  name: "granola_build_analysis_prompt",
  description:
    "Build the user message for the call-analysis agent from a normalized GranolaCall (transcript + context).",
  inputSchema: {
    type: "object",
    properties: {
      note: { description: "GranolaCall object or JSON string." },
      content: {
        description:
          "Optional envelope content when the step output is wrapped.",
      },
    },
  },
};

function buildAnalysisPromptPayload(args: Record<string, unknown>): {
  text: string;
} {
  const candidates = [
    peelRecord(args.note),
    peelRecord(args.content),
    peelRecord(args),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = GranolaCallSchema(candidate);
    if (!(parsed instanceof type.errors)) {
      return { text: buildCallAnalysisUserMessage(parsed) };
    }
  }
  const raw = parseMaybeJson(args.note ?? args.content ?? args);
  const parsed = GranolaCallSchema(raw);
  if (!(parsed instanceof type.errors)) {
    return { text: buildCallAnalysisUserMessage(parsed) };
  }
  throw new Error(
    "granola_build_analysis_prompt: expected a normalized GranolaCall",
  );
}

// ---------------------------------------------------------------------------
// granola_parse_analysis
// ---------------------------------------------------------------------------

export const GRANOLA_PARSE_ANALYSIS_DEFINITION: ToolDefinition = {
  name: "granola_parse_analysis",
  description:
    "Parse an LLM call-analysis reply into validated CallAnalysis JSON (fences stripped).",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Raw model output." },
      content: {
        type: "string",
        description:
          "Optional envelope content when the step output is wrapped.",
      },
      reply: {
        type: "string",
        description: "Alias for text used by some step envelopes.",
      },
    },
  },
};

function readAnalysisText(args: Record<string, unknown>): string {
  for (const key of ["text", "content", "reply", "output"] as const) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  throw new Error(
    "granola_parse_analysis: expected string text/content/reply with model JSON",
  );
}

// ---------------------------------------------------------------------------
// granola_prepare_artifacts
// ---------------------------------------------------------------------------

export const GRANOLA_PREPARE_ARTIFACTS_DEFINITION: ToolDefinition = {
  name: "granola_prepare_artifacts",
  description:
    "Build the three typed Granola call artifact payloads (pain points, summary, brief) as flat fields for write_artifact argMaps.",
  inputSchema: {
    type: "object",
    properties: {
      note: { description: "GranolaCall object or JSON string." },
      analysis: {
        description: "Validated CallAnalysis object or JSON string.",
      },
      classification: {
        type: "string",
        description: "internal | external | unknown",
      },
      content: {
        description:
          "Optional envelope that already embeds note/analysis/classification.",
      },
      normalize: { description: "Optional projected normalize step output." },
      parse: { description: "Optional projected parse step output." },
      classify: { description: "Optional projected classify step output." },
    },
  },
};

function requireCall(args: Record<string, unknown>): GranolaCall {
  const candidates = [
    peelRecord(args.note),
    peelRecord(args.normalize),
    peelRecord(args.content),
    peelRecord(args),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = GranolaCallSchema(candidate);
    if (!(parsed instanceof type.errors)) return parsed;
    if (candidate.note !== undefined) {
      const nested = GranolaCallSchema(parseMaybeJson(candidate.note));
      if (!(nested instanceof type.errors)) return nested;
    }
  }
  throw new Error("granola_prepare_artifacts: note is required");
}

function requireAnalysis(
  args: Record<string, unknown>,
): ReturnType<typeof parseCallAnalysis> {
  const candidates = [
    args.analysis,
    peelRecord(args.parse),
    peelRecord(args.content)?.analysis,
    peelRecord(args)?.analysis,
    peelRecord(args.content),
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate === "string") {
      try {
        return parseCallAnalysis(candidate);
      } catch {
        // try next
      }
    }
    try {
      return parseCallAnalysis(JSON.stringify(parseMaybeJson(candidate)));
    } catch {
      // continue
    }
  }
  throw new Error("granola_prepare_artifacts: analysis is required");
}

function requireClassification(
  args: Record<string, unknown>,
): CallClassification {
  const classifyPeeled = peelRecord(args.classify);
  const contentPeeled = peelRecord(args.content);
  const raw =
    args.classification ??
    contentPeeled?.classification ??
    classifyPeeled?.classification ??
    asRecord(args.classify)?.classification;
  if (raw === "internal" || raw === "external" || raw === "unknown") {
    return raw;
  }
  throw new Error(
    "granola_prepare_artifacts: classification must be internal|external|unknown",
  );
}

function prepareArtifactsPayload(args: Record<string, unknown>) {
  const note = requireCall(args);
  const analysis = requireAnalysis(args);
  const classification = requireClassification(args);
  const kinds = GRANOLA_CALL_ARTIFACT_KINDS;
  return {
    noteId: note.id,
    classification,
    note,
    analysis,
    painTitle: granolaCallArtifactTitle(note.title, "Pain Points"),
    painKind: kinds.painPoints,
    painContent: renderPainPointsContent(note, classification, analysis),
    painSourceRef: granolaCallSourceRef(note.id, kinds.painPoints),
    summaryTitle: granolaCallArtifactTitle(note.title, "Summary"),
    summaryKind: kinds.summary,
    summaryContent: renderSummaryContent(note, classification, analysis),
    summarySourceRef: granolaCallSourceRef(note.id, kinds.summary),
    briefTitle: granolaCallArtifactTitle(note.title, "Brief"),
    briefKind: kinds.brief,
    briefContent: renderBriefContent(note, classification, analysis),
    briefSourceRef: granolaCallSourceRef(note.id, kinds.brief),
  };
}

// ---------------------------------------------------------------------------
// granola_emit_run_outputs
// ---------------------------------------------------------------------------

export const GRANOLA_EMIT_RUN_OUTPUTS_DEFINITION: ToolDefinition = {
  name: "granola_emit_run_outputs",
  description:
    "Assemble the granola-call workflow terminal output: noteId, classification, artifactsByKind.",
  inputSchema: {
    type: "object",
    properties: {
      noteId: { type: "string" },
      classification: { type: "string" },
      painArtifactId: { type: "string" },
      summaryArtifactId: { type: "string" },
      briefArtifactId: { type: "string" },
      content: { description: "Optional envelope carrying the fields above." },
      prepare: { description: "Projected prepare step output." },
      "persist-pain": { description: "Projected persist-pain step output." },
      "persist-summary": {
        description: "Projected persist-summary step output.",
      },
      "persist-brief": { description: "Projected persist-brief step output." },
    },
  },
};

function readStringField(
  args: Record<string, unknown>,
  keys: string[],
): string | undefined {
  const envelope = peelRecord(args.content) ?? asRecord(args.content);
  for (const key of keys) {
    const direct = args[key];
    if (typeof direct === "string" && direct.trim() !== "")
      return direct.trim();
    const fromEnv = envelope?.[key];
    if (typeof fromEnv === "string" && fromEnv.trim() !== "")
      return fromEnv.trim();
  }
  return undefined;
}

function readArtifactId(
  step: Record<string, unknown> | null,
  keys: string[],
): string | undefined {
  if (!step) return undefined;
  const peeled = peelRecord(step) ?? step;
  for (const key of keys) {
    const v = peeled[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const key of keys) {
    const v = step[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function emitRunOutputsPayload(args: Record<string, unknown>) {
  // Projected step outputs arrive as { content: "<json>" } envelopes.
  // Always peel nested content first so noteId/classification survive.
  const prepare = peelRecord(args.prepare);
  const painStep =
    peelRecord(args["persist-pain"]) ?? peelRecord(args.pain) ?? null;
  const summaryStep =
    peelRecord(args["persist-summary"]) ?? peelRecord(args.summary) ?? null;
  const briefStep =
    peelRecord(args["persist-brief"]) ?? peelRecord(args.brief) ?? null;

  const noteId =
    readStringField(args, ["noteId", "id"]) ??
    (typeof prepare?.noteId === "string" ? prepare.noteId : undefined);
  const classification =
    readStringField(args, ["classification"]) ??
    (typeof prepare?.classification === "string"
      ? prepare.classification
      : undefined);

  const pain =
    readStringField(args, [
      "painArtifactId",
      "painPointsArtifactId",
      "painArtifact",
    ]) ?? readArtifactId(painStep, ["artifactId", "painArtifactId", "id"]);
  const summary =
    readStringField(args, ["summaryArtifactId", "summaryArtifact"]) ??
    readArtifactId(summaryStep, ["artifactId", "summaryArtifactId", "id"]);
  const brief =
    readStringField(args, ["briefArtifactId", "briefArtifact"]) ??
    readArtifactId(briefStep, ["artifactId", "briefArtifactId", "id"]);

  if (!noteId) throw new Error("granola_emit_run_outputs: noteId is required");
  if (
    classification !== "internal" &&
    classification !== "external" &&
    classification !== "unknown"
  ) {
    throw new Error(
      "granola_emit_run_outputs: classification must be internal|external|unknown",
    );
  }
  if (!pain || !summary || !brief) {
    throw new Error(
      "granola_emit_run_outputs: pain/summary/brief artifact ids are required",
    );
  }
  return {
    noteId,
    classification,
    artifactsByKind: {
      [GRANOLA_CALL_ARTIFACT_KINDS.painPoints]: pain,
      [GRANOLA_CALL_ARTIFACT_KINDS.summary]: summary,
      [GRANOLA_CALL_ARTIFACT_KINDS.brief]: brief,
    },
  };
}

// ---------------------------------------------------------------------------
// Tool factory + hub proxies
// ---------------------------------------------------------------------------

/** Pure (no hub context) tools used by the granola-call workflow. */
export function createGranolaWorkflowTools(): AgentTool[] {
  return [
    {
      kind: "string",
      definition: GRANOLA_NORMALIZE_NOTE_DEFINITION,
      handler: async (args) => jsonResult(normalizeNotePayload(args)),
    },
    {
      kind: "string",
      definition: GRANOLA_CLASSIFY_CALL_DEFINITION,
      handler: async (args) => jsonResult(classifyCallPayload(args)),
    },
    {
      kind: "string",
      definition: GRANOLA_BUILD_ANALYSIS_PROMPT_DEFINITION,
      handler: async (args) => jsonResult(buildAnalysisPromptPayload(args)),
    },
    {
      kind: "string",
      definition: GRANOLA_PARSE_ANALYSIS_DEFINITION,
      handler: async (args) =>
        jsonResult(parseCallAnalysis(readAnalysisText(args))),
    },
    {
      kind: "string",
      definition: GRANOLA_PREPARE_ARTIFACTS_DEFINITION,
      handler: async (args) => jsonResult(prepareArtifactsPayload(args)),
    },
    {
      kind: "string",
      definition: GRANOLA_EMIT_RUN_OUTPUTS_DEFINITION,
      handler: async (args) => jsonResult(emitRunOutputsPayload(args)),
    },
  ];
}

/**
 * Hub KNOWN_TOOLS proxy entries for the pure granola workflow tools
 * (coexistence with native interchange path — same pattern as last30days).
 */
export const GRANOLA_WORKFLOW_HUB_TOOLS = {
  granola_normalize_note: {
    sideEffect: "read" as const,
    definition: GRANOLA_NORMALIZE_NOTE_DEFINITION,
    createTools: () =>
      createGranolaWorkflowTools().filter(
        (t) => t.definition.name === "granola_normalize_note",
      ),
  },
  granola_classify_call: {
    sideEffect: "read" as const,
    definition: GRANOLA_CLASSIFY_CALL_DEFINITION,
    createTools: () =>
      createGranolaWorkflowTools().filter(
        (t) => t.definition.name === "granola_classify_call",
      ),
  },
  granola_build_analysis_prompt: {
    sideEffect: "read" as const,
    definition: GRANOLA_BUILD_ANALYSIS_PROMPT_DEFINITION,
    createTools: () =>
      createGranolaWorkflowTools().filter(
        (t) => t.definition.name === "granola_build_analysis_prompt",
      ),
  },
  granola_parse_analysis: {
    sideEffect: "read" as const,
    definition: GRANOLA_PARSE_ANALYSIS_DEFINITION,
    createTools: () =>
      createGranolaWorkflowTools().filter(
        (t) => t.definition.name === "granola_parse_analysis",
      ),
  },
  granola_prepare_artifacts: {
    sideEffect: "read" as const,
    definition: GRANOLA_PREPARE_ARTIFACTS_DEFINITION,
    createTools: () =>
      createGranolaWorkflowTools().filter(
        (t) => t.definition.name === "granola_prepare_artifacts",
      ),
  },
  granola_emit_run_outputs: {
    sideEffect: "read" as const,
    definition: GRANOLA_EMIT_RUN_OUTPUTS_DEFINITION,
    createTools: () =>
      createGranolaWorkflowTools().filter(
        (t) => t.definition.name === "granola_emit_run_outputs",
      ),
  },
};
