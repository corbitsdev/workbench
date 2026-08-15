// Renders a routine's stored `input` — the free-form
// `Record<string, unknown>` a stepper collects (topic, focus, ...) — into
// the plain-text content a launched run receives as its first-turn
// message. One `key: value` line per field, in the field's own insertion
// order: readable by a human glancing at the mailbox, and parseable by an
// agent without it having to guess a schema. A scalar renders as itself;
// an object or array renders as its JSON form, since a labeled line still
// needs a single-line value.
//
// A routine's creator is tenant-trusted (only a tenant principal can set
// a routine's `input`), but the rendering is still adversarially framed:
// a key or value containing its own `\n` and a `key:`-shaped line could
// otherwise forge an extra field the agent reads as if this function had
// emitted it. A key is restricted to a strict grammar (letters, digits,
// space, dash, underscore), and every continuation line of a multi-line
// value is indented so it can never read as a fresh top-level field.
const ALLOWED_KEY_CHARACTERS = /[^a-zA-Z0-9 _-]/g;
const CONTINUATION_INDENT = "  ";
const FRAME_HEADER = "Input from this routine's setup:";

function sanitizeInputKey(key: string): string {
  return key.replace(ALLOWED_KEY_CHARACTERS, "");
}

function indentContinuationLines(value: string): string {
  return value.split(/\r\n|\r|\n/).join(`\n${CONTINUATION_INDENT}`);
}

function renderInputValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * `""` when every field's value renders empty (including an empty
 * input) — the caller's signal to send no mail at all, rather than a
 * frame header over nothing but blank fields.
 */
export function renderRoutineInput(input: Record<string, unknown>): string {
  const fields = Object.entries(input).map(([key, value]) => ({
    key: sanitizeInputKey(key),
    value: renderInputValue(value),
  }));

  if (fields.every((field) => field.value === "")) return "";

  const lines = fields.map(
    ({ key, value }) => `${key}: ${indentContinuationLines(value)}`,
  );
  return [FRAME_HEADER, ...lines].join("\n");
}
