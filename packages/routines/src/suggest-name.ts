// A default routine name suggested from free-form prompt text (e.g. a
// task's prompt, carried over by "Make this a routine") — the create
// dialog's Name field is optional and falls back to the picked workflow's
// own name, so this only needs to produce a reasonable starting point a
// person can still edit or clear. First line only (a prompt's later lines
// are usually detail, not a title), trimmed, and capped to a length that
// still reads as a title in the routines list.
const MAX_LENGTH = 60;

export function suggestRoutineNameFromPrompt(prompt: string): string {
  const firstLine = (prompt.trim().split(/\r\n|\r|\n/)[0] ?? "").trim();
  // Code-point-aware, not UTF-16-code-unit-aware: `.length`/`.slice` on a
  // raw string split surrogate pairs (an emoji, or anything outside the
  // BMP) in half, producing an unpaired surrogate — a corrupt string, not
  // just a truncated one. `Array.from` iterates by code point.
  const codePoints = Array.from(firstLine);
  if (codePoints.length <= MAX_LENGTH) return firstLine;
  return `${codePoints
    .slice(0, MAX_LENGTH - 1)
    .join("")
    .trimEnd()}…`;
}
