import type {
  ContentBlock,
  ConversationTurn,
  InferenceOptions,
  LastCycleSource,
} from "@intx/types/runtime";
import {
  BEARER_CREDENTIAL_SENTINEL,
  encodeToolName,
  type BuiltRequest,
  type ProviderAdapter,
  type ToolNameLimit,
} from "@intx/inference";
import { createResponsesBlockIndexer, parseResponse } from "./codex-responses";

// grok-cli OAuth proxy constants (mirror Intercode / live Grok CLI capture).
export const XAI_RESPONSES_PATH = "/responses";
export const XAI_CLIENT_IDENTIFIER = "grok-shell";
export const XAI_CLIENT_VERSION = "0.2.93";
export const XAI_USER_AGENT = "grok-shell/0.2.93 (macos; aarch64)";

// Adapter for the grok-cli OAuth proxy (cli-chat-proxy.grok.com), which serves
// the OpenAI Responses API at /v1/responses. The request shape mirrors the grok
// CLI's own /v1/responses call (captured live): the system prompt rides as a
// leading `system` input message (string content, not parts), reasoning is
// requested by summary, and the caller is identified by x-grok-* headers rather
// than a body field. The Responses SSE protocol is identical to Codex, so the
// stream parser is shared.
//
// HOW THE GROK FLOW WORKS (what this adapter encodes)
//
// What the member connects: a *consumer X / Grok subscription* (SuperGrok or
// the X Premium tier that carries Grok) — not an api.x.ai platform key.
// Authorization is grok-shell's public-client PKCE flow at
// auth.x.ai/oauth2/authorize with the CLI's client id, scopes
// `openid profile email offline_access grok-cli:access api:access`. Token
// exchange at auth.x.ai/oauth2/token sends `client_id` + `code_verifier` and
// NO `client_secret`; `offline_access` yields the refresh token.
//
// The `x-grok-*` headers: unlike Codex there is no account-id claim to lift —
// the proxy derives the account from the bearer token. What it does require is
// caller identification: `x-grok-client-identifier: grok-shell` plus
// `x-grok-client-version` and the matching `user-agent`. Identifying as
// grok-shell is what admits the request to cli-chat-proxy.grok.com at all and
// selects the CLI entitlement path (subscription quota, not API billing);
// requests without it are rejected by the proxy. `x-grok-model-override`
// carries the model — the proxy routes on the header, not only on the body
// `model` field. `x-grok-user-id` is sent only when the connection supplied
// one (`grokUserId` in providerOptions) and is purely a correlation hint.
//
// How this differs from the Codex Responses variant, despite the shared SSE
// parser: (1) no pinned `instructions` field — the proxy accepts an arbitrary
// system prompt, so it rides as a plain leading `system` message with *string*
// content rather than Codex's developer-message bridge; (2) reasoning is asked
// for as `reasoning: { summary: "auto" }` with no `effort` knob; (3) no
// `parallel_tool_calls` / `prompt_cache_key` / `session_id` — the proxy has no
// server-side session; (4) tool outputs are de-duplicated by `call_id` before
// send, because the proxy 400s on a repeated `function_call_output` for the
// same call. Everything downstream — flat function tools, `store: false`,
// `include: ["reasoning.encrypted_content"]`, and the encrypted-reasoning
// round-trip through thinking-block signatures — is identical to Codex.
//
// Quota and revocation: calls bill the member's personal Grok subscription
// quota; no tenant spend. On revocation at x.ai or refresh-token expiry the
// hub's refresh fails (logged), the stale token is kept, and the next
// inference returns 401 from the proxy until the member reconnects.

export const GROK_RESPONSES_PROVIDER = "grok-responses";

// Key the source stashes in defaults.providerOptions for this adapter.
export const GROK_USER_ID_OPTION = "grokUserId";

// Same OpenAI-style tool-name charset as Chat Completions / Codex Responses.
const RESPONSES_TOOL_NAME_LIMIT: ToolNameLimit = {
  provider: "grok-responses",
  maxLength: 64,
};

type ResponsesInputContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string };

type ResponsesInputItem =
  | {
      type: "message";
      role: "user" | "assistant" | "system";
      content: string | ResponsesInputContentPart[];
    }
  | { type: "function_call"; name: string; arguments: string; call_id: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "reasoning"; summary: never[]; encrypted_content: string };

function toolResultText(
  block: Extract<ContentBlock, { type: "tool_result" }>,
): string {
  const parts: string[] = [];
  for (const c of block.content) {
    if (c.type === "text") parts.push(c.text);
    else parts.push(`[unsupported ${c.type} content omitted]`);
  }
  return parts.join("");
}

// Map one internal turn to Responses items. Text-only messages keep the string
// shape grok sends; messages with image blocks switch to Responses content parts
// so the model receives the actual pixels instead of only a text placeholder.
function toResponsesItems(turn: ConversationTurn): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  const role = turn.role;
  const parts: ResponsesInputContentPart[] = [];
  let hasImage = false;

  const flushMessage = (): void => {
    if (parts.length === 0) return;
    items.push({
      type: "message",
      role,
      content: hasImage
        ? [...parts]
        : parts
            .map((part) => (part.type === "input_text" ? part.text : ""))
            .join(""),
    });
    parts.length = 0;
    hasImage = false;
  };

  for (const block of turn.content) {
    if (block.type === "text") {
      parts.push({ type: "input_text", text: block.text });
    } else if (block.type === "image") {
      if (block.source.kind === "base64") {
        hasImage = true;
        parts.push({
          type: "input_image",
          image_url: `data:${block.source.mimeType};base64,${block.source.data}`,
        });
      } else if (block.source.kind === "url") {
        hasImage = true;
        parts.push({ type: "input_image", image_url: block.source.url });
      } else {
        parts.push({
          type: "input_text",
          text: `[Unsupported image reference omitted: ${block.source.reference}]`,
        });
      }
    } else if (block.type === "tool_call") {
      flushMessage();
      items.push({
        type: "function_call",
        name: encodeToolName(block.name, RESPONSES_TOOL_NAME_LIMIT),
        arguments: JSON.stringify(block.arguments ?? {}),
        call_id: block.id,
      });
    } else if (block.type === "tool_result") {
      flushMessage();
      items.push({
        type: "function_call_output",
        call_id: block.callId,
        output: toolResultText(block),
      });
    } else if (
      block.type === "thinking" &&
      typeof block.signature === "string" &&
      block.signature.length > 0
    ) {
      flushMessage();
      items.push({
        type: "reasoning",
        summary: [],
        encrypted_content: block.signature,
      });
    }
  }
  flushMessage();
  return items;
}

function toResponsesTools(options: InferenceOptions): unknown[] | undefined {
  if (options.tools === undefined || options.tools.length === 0)
    return undefined;
  return options.tools.map((t) => ({
    type: "function",
    name: encodeToolName(t.name, RESPONSES_TOOL_NAME_LIMIT),
    description: t.description,
    parameters: t.inputSchema,
  }));
}

function optionString(
  options: InferenceOptions,
  key: string,
): string | undefined {
  const value = options.providerOptions?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function dedupeToolOutputs(items: ResponsesInputItem[]): ResponsesInputItem[] {
  const seen = new Set<string>();
  const deduped: ResponsesInputItem[] = [];
  for (const item of items) {
    if (item.type === "function_call_output") {
      if (seen.has(item.call_id)) continue;
      seen.add(item.call_id);
    }
    deduped.push(item);
  }
  return deduped;
}

function buildRequest(
  messages: ConversationTurn[],
  model: string,
  options: InferenceOptions,
): BuiltRequest {
  const conversation = dedupeToolOutputs(messages.flatMap(toResponsesItems));
  const systemMessage: ResponsesInputItem | undefined =
    options.systemPrompt !== undefined
      ? { type: "message", role: "system", content: options.systemPrompt }
      : undefined;
  const input =
    systemMessage !== undefined
      ? [systemMessage, ...conversation]
      : conversation;
  const tools = toResponsesTools(options);

  const body: Record<string, unknown> = {
    model,
    input,
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    reasoning: { summary: "auto" },
  };
  if (tools !== undefined) {
    body["tools"] = tools;
    body["tool_choice"] = "auto";
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: BEARER_CREDENTIAL_SENTINEL,
    "user-agent": XAI_USER_AGENT,
    "x-grok-client-identifier": XAI_CLIENT_IDENTIFIER,
    "x-grok-client-version": XAI_CLIENT_VERSION,
    "x-grok-model-override": model,
  };
  const userId = optionString(options, GROK_USER_ID_OPTION);
  if (userId !== undefined) headers["x-grok-user-id"] = userId;

  return { url: XAI_RESPONSES_PATH, headers, body: JSON.stringify(body) };
}

export function createGrokResponsesAdapter(
  source: LastCycleSource,
): ProviderAdapter {
  const indexer = createResponsesBlockIndexer();
  return {
    buildRequest,
    parseResponse: (sseData) =>
      parseResponse(sseData, indexer, source, GROK_RESPONSES_PROVIDER),
  };
}
