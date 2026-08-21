import { type } from "arktype";

// Ollama's own `/api/show` capability vocabulary — the same strings
// `@workbench/hub-client`'s `OLLAMA_CAPABILITY_MAP` translates from. A
// catalogue entry scripts these directly so model-selection logic
// (`preferCompletionCapable`, capability probing) is testable against the
// exact values the real instance would answer, with no translation layer
// duplicated in the mock.
export type OllamaCapability =
  "completion" | "embedding" | "tools" | "vision" | "insert";

export type OllamaCatalogEntry = {
  readonly name: string;
  readonly capabilities?: readonly OllamaCapability[];
  readonly digest?: string;
  readonly size?: number;
};

export type OllamaToolCall = {
  readonly name: string;
  readonly arguments: unknown;
};

/**
 * What a scripted `onChat` handler hands back. `text` alone is a plain
 * assistant reply; `toolCalls` puts the model in the tool-call branch a
 * real completion-capable model takes when its declared tools cover the
 * turn. Both may be set (a model that narrates before calling a tool).
 */
export type OllamaChatReply = {
  readonly text?: string;
  readonly toolCalls?: readonly OllamaToolCall[];
  readonly finishReason?: "stop" | "tool_calls" | "length";
};

export type CapturedToolDeclaration = {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
};

export type CapturedMessageRole = "system" | "user" | "assistant" | "tool";

export type CapturedMessage = {
  readonly role: CapturedMessageRole;
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly OllamaToolCall[];
};

// The OpenAI-compatible chat-completions request body, as `@intx/inference`'s
// openai adapter actually builds it (`buildRequest` in
// `providers/openai.js`) and Ollama's `/v1/chat/completions` route
// receives it. Parsed at the boundary — this is the mock server reading
// a request it did not construct — so a caller sending a malformed body
// surfaces a clear parse error instead of a downstream `undefined` crash.
const ChatCompletionTool = type({
  type: "'function'",
  function: {
    name: "string",
    "description?": "string",
    "parameters?": "unknown",
  },
});

const ChatCompletionToolCall = type({
  id: "string",
  type: "'function'",
  function: { name: "string", arguments: "string" },
});

const ChatCompletionMessage = type({
  role: "'system' | 'user' | 'assistant' | 'tool'",
  "content?": "string | null",
  "tool_call_id?": "string",
  "tool_calls?": ChatCompletionToolCall.array(),
});

export const ChatCompletionRequestBody = type({
  model: "string",
  messages: ChatCompletionMessage.array(),
  "tools?": ChatCompletionTool.array(),
  "stream?": "boolean",
  "temperature?": "number",
});

export type ChatCompletionRequestBody = typeof ChatCompletionRequestBody.infer;
