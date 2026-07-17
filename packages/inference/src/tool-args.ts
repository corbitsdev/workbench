// Tool-call argument recovery.
//
// Some OpenAI-compatible providers (kimi-k2.6 via OpenRouter) mis-assemble
// streamed tool-call arguments: duplicated deltas concatenate into invalid
// JSON, and once the harness's `{_raw: buffer}` fallback lands in history the
// model imitates the shape on every retry — emitting `{"_raw": "<stringified
// args>"}` itself. Each retry fails schema validation at the tool and
// re-triggers the same approval gate, looping forever.
//
// This module recovers the real arguments at two seams: parse time (harness
// finalize) and history re-serialization (provider marshaling), so a _raw
// envelope neither reaches a tool nor reaches the model.
import { type } from "arktype";

const ToolArgsRecord = type("Record<string, unknown>");

function asRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return null;
  const validated = ToolArgsRecord(value);
  return validated instanceof type.errors ? null : validated;
}

function parseRecord(raw: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * If the arguments are exactly `{_raw: string}` and the string parses to an
 * object, return the inner object; otherwise return the arguments unchanged.
 */
export function unwrapRawToolArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const keys = Object.keys(args);
  const raw = args["_raw"];
  if (keys.length !== 1 || typeof raw !== "string") return args;
  return parseRecord(raw) ?? args;
}

/**
 * Extract the first balanced top-level JSON object from a buffer that may
 * contain trailing garbage (e.g. the same object concatenated twice by
 * duplicated stream deltas). Brace scanning respects string literals.
 */
function salvageFirstJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw.startsWith("{")) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return parseRecord(raw.slice(0, i + 1));
    }
  }
  return null;
}

/**
 * Parse a completed tool-call argument buffer, recovering from the known
 * provider failure shapes before falling back to `{_raw: buffer}`:
 * - model-emitted `{_raw: "<stringified args>"}` envelopes are unwrapped
 * - double-encoded JSON strings are parsed twice
 * - duplicated concatenated objects are salvaged from the first balanced one
 */
export function parseCompletedToolArgs(
  buffer: string,
): Record<string, unknown> {
  const raw = buffer.trim() === "" ? "{}" : buffer.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const salvaged = salvageFirstJsonObject(raw);
    if (salvaged !== null) return unwrapRawToolArgs(salvaged);
    return { _raw: buffer };
  }
  const record = asRecord(parsed);
  if (record !== null) return unwrapRawToolArgs(record);
  if (typeof parsed === "string") {
    const inner = parseRecord(parsed);
    if (inner !== null) return unwrapRawToolArgs(inner);
  }
  return {};
}

/**
 * Sanitize stored tool-call arguments before re-serializing them into the
 * provider conversation. A `{_raw}` envelope must never round-trip to the
 * model — it imitates the shape on subsequent calls. Unrecoverable envelopes
 * degrade to `{}` rather than echoing the poison.
 */
export function sanitizeToolArgsForHistory(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const unwrapped = unwrapRawToolArgs(args);
  const keys = Object.keys(unwrapped);
  if (keys.length === 1 && typeof unwrapped["_raw"] === "string") return {};
  return unwrapped;
}
