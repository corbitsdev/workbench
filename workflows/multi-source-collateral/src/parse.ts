import { type } from "arktype";

// ---------------------------------------------------------------------------
// List parsers — distinguish empty vs failed (gamma pattern)
// ---------------------------------------------------------------------------

const ArtifactItem = type({
  id: "string",
  "title?": "string | null",
  "kind?": "string | null",
  "createdAt?": "string | null",
});
export type ArtifactItem = typeof ArtifactItem.infer;

const ArtifactListResult = type({ artifacts: ArtifactItem.array() });

const NoteItem = type({
  id: "string",
  "title?": "string | null",
  "summary?": "string | null",
  "createdAt?": "string | null",
});
export type NoteItem = typeof NoteItem.infer;

const NoteListResult = type({
  "notes?": NoteItem.array(),
  "items?": NoteItem.array(),
});

const LinearIssueItem = type({
  id: "string",
  "identifier?": "string | null",
  "title?": "string | null",
  "description?": "string | null",
  "state?": "string | null",
  "url?": "string | null",
});
export type LinearIssueItem = typeof LinearIssueItem.infer;

const LinearListResult = type({
  "issues?": LinearIssueItem.array(),
  "nodes?": LinearIssueItem.array(),
  "items?": LinearIssueItem.array(),
});

export type ParseResult<T> =
  | { status: "ok"; value: T }
  | { status: "empty" }
  | { status: "failed" };

function unwrapToolPayload(raw: unknown): unknown {
  if (raw === null || raw === undefined) return raw;
  if (typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;
  // Deterministic tool step may wrap under result / data / output
  if ("result" in obj) return obj.result;
  if ("data" in obj) return obj.data;
  if ("output" in obj) return obj.output;
  return raw;
}

export function parseArtifactList(raw: unknown): ParseResult<ArtifactItem[]> {
  if (raw === undefined || raw === null) return { status: "failed" };
  const inner = unwrapToolPayload(raw);
  if (Array.isArray(inner)) {
    const parsed = ArtifactItem.array()(inner);
    if (parsed instanceof type.errors) return { status: "failed" };
    return parsed.length === 0
      ? { status: "empty" }
      : { status: "ok", value: parsed };
  }
  const parsed = ArtifactListResult(inner);
  if (parsed instanceof type.errors) return { status: "failed" };
  return parsed.artifacts.length === 0
    ? { status: "empty" }
    : { status: "ok", value: parsed.artifacts };
}

export function parseNoteList(raw: unknown): ParseResult<NoteItem[]> {
  if (raw === undefined || raw === null) return { status: "failed" };
  const inner = unwrapToolPayload(raw);
  if (Array.isArray(inner)) {
    const parsed = NoteItem.array()(inner);
    if (parsed instanceof type.errors) return { status: "failed" };
    return parsed.length === 0
      ? { status: "empty" }
      : { status: "ok", value: parsed };
  }
  const parsed = NoteListResult(inner);
  if (parsed instanceof type.errors) return { status: "failed" };
  const notes = parsed.notes ?? parsed.items ?? [];
  return notes.length === 0
    ? { status: "empty" }
    : { status: "ok", value: notes };
}

export function parseIssueList(raw: unknown): ParseResult<LinearIssueItem[]> {
  if (raw === undefined || raw === null) return { status: "failed" };
  const inner = unwrapToolPayload(raw);
  if (Array.isArray(inner)) {
    const parsed = LinearIssueItem.array()(inner);
    if (parsed instanceof type.errors) return { status: "failed" };
    return parsed.length === 0
      ? { status: "empty" }
      : { status: "ok", value: parsed };
  }
  const parsed = LinearListResult(inner);
  if (parsed instanceof type.errors) return { status: "failed" };
  const issues = parsed.issues ?? parsed.nodes ?? parsed.items ?? [];
  return issues.length === 0
    ? { status: "empty" }
    : { status: "ok", value: issues };
}

// ---------------------------------------------------------------------------
// Fetch output → source context text
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

function stringField(
  obj: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return undefined;
}

export function extractArtifactText(raw: unknown): string {
  const inner = unwrapToolPayload(raw);
  const obj = asRecord(inner);
  if (!obj) {
    return typeof inner === "string" ? inner : JSON.stringify(inner ?? "");
  }
  const title = stringField(obj, ["title"]) ?? "Artifact";
  const content =
    stringField(obj, ["content", "body", "text", "markdown"]) ??
    JSON.stringify(obj);
  return `### Artifact: ${title}\n${content}`;
}

export function extractNoteText(raw: unknown): string {
  const inner = unwrapToolPayload(raw);
  const obj = asRecord(inner);
  if (!obj) {
    return typeof inner === "string" ? inner : JSON.stringify(inner ?? "");
  }
  const title = stringField(obj, ["title"]) ?? "Call note";
  const content =
    stringField(obj, [
      "transcript",
      "content",
      "summary",
      "notes",
      "body",
      "text",
    ]) ?? JSON.stringify(obj);
  return `### Granola note: ${title}\n${content}`;
}

export function extractIssueText(raw: unknown): string {
  const inner = unwrapToolPayload(raw);
  const obj = asRecord(inner);
  if (!obj) {
    return typeof inner === "string" ? inner : JSON.stringify(inner ?? "");
  }
  const id =
    stringField(obj, ["identifier", "id"]) ?? "issue";
  const title = stringField(obj, ["title"]) ?? "";
  const description =
    stringField(obj, ["description", "body", "content"]) ?? "";
  return `### Linear ${id}: ${title}\n${description}`;
}

export function buildSourceContext(args: {
  artifactOutputs?: unknown[];
  noteOutputs?: unknown[];
  issueOutputs?: unknown[];
  text?: string;
}): string {
  const parts: string[] = [];
  for (const a of args.artifactOutputs ?? []) {
    parts.push(extractArtifactText(a));
  }
  for (const n of args.noteOutputs ?? []) {
    parts.push(extractNoteText(n));
  }
  for (const i of args.issueOutputs ?? []) {
    parts.push(extractIssueText(i));
  }
  const free = args.text?.trim();
  if (free) {
    parts.push(`### Free text\n${free}`);
  }
  return parts.join("\n\n").trim();
}

// ---------------------------------------------------------------------------
// Generated pieces
// ---------------------------------------------------------------------------

const GeneratedPieceSchema = type({
  format: "string",
  title: "string",
  content: "string",
});
export type GeneratedPiece = typeof GeneratedPieceSchema.infer;

function tryParsePiece(raw: unknown): GeneratedPiece | null {
  if (typeof raw === "string") {
    try {
      return tryParsePiece(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  const unwrapped = unwrapToolPayload(raw);
  const obj = asRecord(unwrapped);
  if (!obj) return null;
  // inline inference may nest under message / text / reply
  if (typeof obj.reply === "string") {
    try {
      return tryParsePiece(JSON.parse(obj.reply));
    } catch {
      /* fall through */
    }
  }
  if (typeof obj.text === "string") {
    try {
      return tryParsePiece(JSON.parse(obj.text));
    } catch {
      /* fall through */
    }
  }
  if (typeof obj.content === "string" && !("format" in obj) && !("title" in obj)) {
    try {
      return tryParsePiece(JSON.parse(obj.content));
    } catch {
      /* fall through */
    }
  }
  const format =
    stringField(obj, ["format", "contentType"]) ?? "unknown";
  const title = stringField(obj, ["title"]) ?? "Untitled";
  const content = stringField(obj, ["content", "body"]) ?? "";
  if (!content) return null;
  const piece = { format, title, content };
  const validated = GeneratedPieceSchema(piece);
  return validated instanceof type.errors ? null : validated;
}

export function parseGeneratedPieces(raw: unknown): GeneratedPiece[] {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((item) => tryParsePiece(item))
      .filter((p): p is GeneratedPiece => p !== null);
  }
  // map step may return { results: [...] } or { items: [...] }
  const obj = asRecord(raw);
  if (obj) {
    const list =
      (Array.isArray(obj.results) && obj.results) ||
      (Array.isArray(obj.items) && obj.items) ||
      (Array.isArray(obj.outputs) && obj.outputs) ||
      null;
    if (list) {
      return list
        .map((item) => tryParsePiece(item))
        .filter((p): p is GeneratedPiece => p !== null);
    }
    const single = tryParsePiece(obj);
    return single ? [single] : [];
  }
  return [];
}

export function mapOutputsArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const obj = asRecord(raw);
  if (!obj) return [];
  if (Array.isArray(obj.results)) return obj.results;
  if (Array.isArray(obj.items)) return obj.items;
  if (Array.isArray(obj.outputs)) return obj.outputs;
  return [];
}
