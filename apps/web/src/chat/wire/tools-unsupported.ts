// Mirrored from packages/chat/src: apps/web and @/chat
// must not import @corbits/chat, a server-only package. This is the browser-
// facing half of the same wire contract the hub's chat routes still speak;
// once the hub moves onto native mail threads (T5a/T5c) this file becomes
// the one source of truth and packages/chat's copy goes away.

/**
 * Named consumer copy for an inference failure whose real cause is that
 * the agent's model cannot use tools. Provider dumps, HTTP status, and
 * catalog/registry capability strings never belong on the timeline.
 */

export const TOOLS_UNSUPPORTED_CONSUMER_MESSAGE = "This agent's model can't use tools.";

/**
 * Conservative match: provider/inference errors about tools /
 * function-calling plus unsupported / not supported / a missing required
 * capability. An unrelated HTTP 400, an embedding model's "does not
 * support generate", an ordinary reply that happens to mention tools,
 * or connector prose like "The grep tool is not supported in this
 * sandbox" must not match. Singular "tool" next to "not supported" is
 * ordinary tool-availability copy, not a model-capability failure.
 */
const TOOLS_UNSUPPORTED_RE =
  /\b(?:tools|tool use)\b[^.]{0,80}\b(?:is |are |use is )?not supported\b|\b(?:is |are )?not supported\b[^.]{0,80}\b(?:tools\b|tool use)\b|\bdoes(?: not|n't) support (?:tools?|tool use|function[\s-]?calling)\b|\bfunction[\s-]?calling\b[^.]{0,80}\b(?:not supported|unsupported|required|missing)\b|\b(?:not supported|unsupported|required|missing)\b[^.]{0,80}\bfunction[\s-]?calling\b/i;

export function isToolsUnsupportedInferenceText(raw: string): boolean {
  return TOOLS_UNSUPPORTED_RE.test(raw);
}
