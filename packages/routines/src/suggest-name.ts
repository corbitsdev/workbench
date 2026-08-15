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
  if (firstLine.length <= MAX_LENGTH) return firstLine;
  return `${firstLine.slice(0, MAX_LENGTH - 1).trimEnd()}…`;
}
