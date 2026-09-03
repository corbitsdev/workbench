/**
 * Named consumer copy for an inference failure whose real cause is that
 * the agent's model cannot use tools. Provider dumps, HTTP status, and
 * catalog/registry capability strings never belong on the timeline.
 */

export const TOOLS_UNSUPPORTED_CONSUMER_MESSAGE =
  "This agent's model can't use tools.";

/**
 * Conservative match: tools / function-calling plus unsupported / not
 * supported / a missing required capability. An unrelated HTTP 400, an
 * embedding model's "does not support generate", or an ordinary reply
 * that happens to mention tools must not match.
 */
const TOOLS_UNSUPPORTED_RE =
  /\btools?\b[^.]{0,80}\b(?:is |are |use is )?not supported\b|\b(?:is |are )?not supported\b[^.]{0,80}\btools?\b|\bdoes(?: not|n't) support (?:tools?|tool use|function[\s-]?calling)\b|\bfunction[\s-]?calling\b[^.]{0,80}\b(?:not supported|unsupported|required|missing)\b|\b(?:not supported|unsupported|required|missing)\b[^.]{0,80}\bfunction[\s-]?calling\b/i;

export function isToolsUnsupportedInferenceText(raw: string): boolean {
  return TOOLS_UNSUPPORTED_RE.test(raw);
}
