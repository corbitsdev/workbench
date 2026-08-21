// decodeToolName (from @intx/inference) is deliberately total: a
// hallucinated or provider-mangled function name is returned verbatim
// rather than throwing, so a bad tool-call name never tears down the
// stream mid-turn. But encodeToolName -- used to put a persisted tool
// name back on the wire when the *next* turn's request is built -- throws
// on a name it cannot re-encode (too long once escaped, or carrying a
// multi-byte character). Persisting a decoded name unchecked means that
// fault surfaces one turn late, after the bad data is already durable:
// every following turn in the room dies rebuilding its request, forever
// (CL-6478).
//
// This is the one place a decoded tool name is accepted into turn
// history. Only a name encodeToolName can invert is persisted as-is;
// anything else collapses to a stable placeholder, so a single bad
// tool-call name can never permanently wedge a room.
import { encodeToolName } from "@intx/inference";

// The tightest tool-name wire limit among the OpenAI-compatible providers
// workbench talks to (OpenAI, xAI, Groq, DeepSeek, Mistral, OpenRouter,
// Ollama all cap at 64). Used only as this module's round-trip sanity
// check, not as the wire encoding an outbound request actually sends.
const ROUND_TRIP_LIMIT = { provider: "round-trip-check", maxLength: 64 } as const;

export const MALFORMED_TOOL_NAME = "malformed_tool_call";

export function sanitizeToolNameForPersistence(name: string): string {
  try {
    encodeToolName(name, ROUND_TRIP_LIMIT);
    return name;
  } catch {
    return MALFORMED_TOOL_NAME;
  }
}
