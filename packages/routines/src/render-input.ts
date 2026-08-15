// Renders a routine's stored `input` — the free-form
// `Record<string, unknown>` a stepper collects (topic, focus, ...) — into
// the plain-text content a launched run receives as its first-turn
// message. One `key: value` line per field, in the field's own insertion
// order: readable by a human glancing at the mailbox, and parseable by an
// agent without it having to guess a schema. A scalar renders as itself;
// an object or array renders as its JSON form, since a labeled line still
// needs a single-line value.
function renderInputValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/** `""` for an empty input — the caller's signal to send no mail at all. */
export function renderRoutineInput(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(([key, value]) => `${key}: ${renderInputValue(value)}`)
    .join("\n");
}
