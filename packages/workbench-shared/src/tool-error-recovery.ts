// A single line of guidance appended to tool ERROR results only, at the
// seam(s) that shape what the model actually receives as tool-result text
// (currently the hub-backed tool-credential rail's `/api/internal/hub-tools/run`
// forwarding in `@workbench/tool-credentials`). Never appended to success
// results. Exported once so every call site shares the exact string and an
// idempotent append helper guards against double-injection if a caller's
// error text has already passed through another layer that appended it.
export const TOOL_ERROR_RECOVERY_GUIDANCE =
  "Recovery: retry at most once with a changed approach; if it still fails, change strategy or report what succeeded, what failed, and what you'd try differently — do not repeat the same call.";

/**
 * Appends {@link TOOL_ERROR_RECOVERY_GUIDANCE} to an error message, unless it
 * is already present — so a message that has already flowed through another
 * seam that appended the guidance is not doubled up.
 */
export function withToolErrorRecoveryGuidance(message: string): string {
  if (message.includes(TOOL_ERROR_RECOVERY_GUIDANCE)) {
    return message;
  }
  return `${message}\n\n${TOOL_ERROR_RECOVERY_GUIDANCE}`;
}
