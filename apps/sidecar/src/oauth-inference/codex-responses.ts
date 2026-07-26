import type {
  ContentBlock,
  ConversationTurn,
  InferenceEvent,
  InferenceOptions,
  LastCycleSource,
  PartialMessage,
  TokenUsage,
} from "@intx/types/runtime";
import {
  BEARER_CREDENTIAL_SENTINEL,
  decodeToolName,
  encodeToolName,
  ProtocolMismatchError,
  type BuiltRequest,
  type ProviderAdapter,
  type ToolNameLimit,
} from "@intx/inference";
import { codexInstructions } from "./codex-instructions";

// Responses path relative to chatgpt.com/backend-api.
export const CODEX_RESPONSES_PATH = "/codex/responses";
export const CODEX_ORIGINATOR = "codex_cli_rs";

// Adapter for the OpenAI Responses API as served by the Codex backend
// (chatgpt.com/backend-api/codex/responses). The Codex backend does NOT speak
// Chat Completions: requests use Responses `input` items + flat tools, and the
// stream is the Responses SSE event protocol. Registered under the provider id
// "codex-responses"; sources for `codex/<profile>` providers are built with
// that id so the harness routes them here instead of the OpenAI adapter.
//
// HOW THE CODEX FLOW WORKS (what this adapter encodes)
//
// What the member connects: a *consumer ChatGPT subscription* (Plus / Pro /
// Business seat) — not a platform.openai.com API key. Authorization runs the
// Codex CLI's own public-client PKCE flow at auth.openai.com/oauth/authorize
// with the CLI's client id and `codex_cli_simplified_flow=true`,
// `id_token_add_organizations=true`, `originator=codex_cli_rs`. The token
// endpoint (auth.openai.com/oauth/token) is a public client: the exchange
// carries `client_id` + `code_verifier` and NO `client_secret`. It returns
// access_token, refresh_token (via `offline_access`) and an `id_token`.
//
// Why `accountIdFromIdToken`: the Codex backend is multi-account. The access
// token alone does not say which ChatGPT workspace/account to bill and
// entitle, so the backend requires a `chatgpt-account-id` header. That id is
// a claim inside the `id_token` JWT payload — under the
// `https://api.openai.com/auth` namespace as `chatgpt_account_id` (some token
// variants put it at the top level). The hub decodes the payload at connect
// time and stores it on the credential's metadata; it rides to launch in
// `source.defaults.providerOptions.codexAccountId` and is lifted into the
// header here. The JWT is not signature-verified: it was just issued to us
// over TLS by the authorization server and the claim is only used to select
// an account the token already authorizes.
//
// Why `originator: codex_cli_rs`: the backend gates the /codex/responses
// surface on the client identifying itself as the Codex CLI. It selects the
// CLI entitlement path (subscription quota rather than API billing) and is
// part of the request-shape contract the backend validates.
//
// Responses vs Chat Completions: this endpoint speaks *only* Responses.
// Differences that matter here — conversation is a flat `input` item array
// (`message`/`function_call`/`function_call_output`/`reasoning`) rather than
// `messages`; function tools are FLAT (`{type,name,description,parameters}`)
// rather than nested under `function`; the reply is a semantic SSE event
// stream (`response.output_text.delta`, `response.output_item.*`,
// `response.completed`) terminated by a lifecycle event rather than `[DONE]`;
// and `instructions` is a first-class field that the backend pins to the
// official Codex prompt (anything else 400s), which is why Workbench's own
// operating prompt rides as a leading developer message instead.
//
// Encrypted reasoning round-trip: the request sets `store: false` (the backend
// keeps no server-side state) plus `include: ["reasoning.encrypted_content"]`.
// The model's reasoning therefore comes back as an opaque, server-encrypted
// blob on `response.output_item.done` for each `reasoning` item. We stash it
// as the *signature* of the corresponding thinking block, and on the next turn
// echo it back as a `{type:"reasoning", encrypted_content}` input item. That
// is what preserves chain-of-thought continuity across tool-call round trips
// without the backend storing anything and without Workbench ever seeing the
// plaintext reasoning.
//
// Quota and revocation: every call bills the member's personal ChatGPT
// subscription quota — there is no tenant API spend. Rate/usage limits are the
// consumer plan's. If the member revokes Workbench in ChatGPT settings, or the
// refresh token expires, the refresh call at
// `apps/hub/src/lib/user-oauth-inference.ts` fails; it is logged and the stale
// access token is left in place, so the next inference returns 401/403 from
// the backend and the member must reconnect.
//
// Credentials and the chatgpt-account-id ride through differently: the access
// token is injected by the harness via the bearer sentinel, while the account
// id and session id travel in `source.defaults.providerOptions` (merged into
// InferenceOptions.providerOptions by the harness) and are lifted into headers
// here. Neither is placed in the request body.

export const CODEX_RESPONSES_PROVIDER = "codex-responses";

// Keys the source stashes in defaults.providerOptions for this adapter.
export const CODEX_ACCOUNT_ID_OPTION = "codexAccountId";
export const CODEX_SESSION_ID_OPTION = "codexSessionId";

// OpenAI Responses tool names share Chat Completions charset/length limits.
const RESPONSES_TOOL_NAME_LIMIT: ToolNameLimit = {
  provider: "codex-responses",
  maxLength: 64,
};

const EMPTY_PARTIAL: PartialMessage = { text: "" };

// ---------------------------------------------------------------------------
// Request building — internal turns → Responses `input` items
// ---------------------------------------------------------------------------

type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string };

type ResponsesInputItem =
  | {
      type: "message";
      role: "user" | "assistant" | "system" | "developer";
      content: ResponsesContentPart[];
    }
  | { type: "function_call"; name: string; arguments: string; call_id: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "reasoning"; summary: never[]; encrypted_content: string };

// Map one internal turn to zero or more Responses items. Assistant text uses
// `output_text` parts; user/system text uses `input_text`. Tool calls become
// `function_call` items (arguments serialized to a JSON string) and tool
// results become `function_call_output` items. Reasoning blocks are echoed
// back only when they carry the opaque `encrypted_content` the backend issued
// (held in a thinking block's signature), which is required for multi-turn
// reasoning continuity.
function toResponsesItems(turn: ConversationTurn): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  const textKind: "input_text" | "output_text" =
    turn.role === "assistant" ? "output_text" : "input_text";
  const textParts: ResponsesContentPart[] = [];

  const flushText = (): void => {
    if (textParts.length > 0) {
      items.push({ type: "message", role: turn.role, content: [...textParts] });
      textParts.length = 0;
    }
  };

  for (const block of turn.content) {
    if (block.type === "text") {
      textParts.push({
        type: textKind,
        text: block.text,
      } as ResponsesContentPart);
    } else if (block.type === "image") {
      if (block.source.kind === "base64") {
        textParts.push({
          type: "input_image",
          image_url: `data:${block.source.mimeType};base64,${block.source.data}`,
        });
      } else if (block.source.kind === "url") {
        textParts.push({ type: "input_image", image_url: block.source.url });
      } else {
        textParts.push({
          type: textKind,
          text: `[Unsupported image reference omitted: ${block.source.reference}]`,
        } as ResponsesContentPart);
      }
    } else if (block.type === "tool_call") {
      flushText();
      items.push({
        type: "function_call",
        name: encodeToolName(block.name, RESPONSES_TOOL_NAME_LIMIT),
        arguments: JSON.stringify(block.arguments ?? {}),
        call_id: block.id,
      });
    } else if (block.type === "tool_result") {
      flushText();
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
      flushText();
      items.push({
        type: "reasoning",
        summary: [],
        encrypted_content: block.signature,
      });
    }
  }
  flushText();
  return items;
}

// Tool results carry a content array; the Responses API wants a string. Join
// the text parts; non-text content (images, etc.) is not representable here and
// is dropped with a marker so the model is not misled into thinking it is
// missing silently.
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

function toResponsesTools(options: InferenceOptions): unknown[] | undefined {
  if (options.tools === undefined || options.tools.length === 0)
    return undefined;
  // Responses function tools are FLAT — name/description/parameters sit beside
  // `type`, not nested under a `function` key (unlike Chat Completions).
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

// `instructions` is pinned to the official Codex prompt (the backend rejects
// anything else), so Intercode's operating prompt rides as a leading developer
// message that also neutralizes the Codex prompt's references to tools that do
// not exist here. The function tools sent with the request are authoritative.
function bridgeMessage(systemPrompt: string): ResponsesInputItem {
  const text = `<workbench_environment priority="0">
You are NOT running in the Codex CLI. You are running in Workbench, a different harness. The base instructions above describe Codex CLI tools (apply_patch, update_plan, shell) that DO NOT EXIST here. Ignore every tool reference in the base instructions and use ONLY the function tools provided in this request. The following are your authoritative operating instructions:

${systemPrompt}
</workbench_environment>`;
  return {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text }],
  };
}

function buildRequest(
  messages: ConversationTurn[],
  model: string,
  options: InferenceOptions,
): BuiltRequest {
  const conversation = messages.flatMap(toResponsesItems);
  // Intercode's prompt cannot live in `instructions` (the backend pins that to
  // the official Codex prompt), so it leads the input as a developer message.
  const input =
    options.systemPrompt !== undefined
      ? [bridgeMessage(options.systemPrompt), ...conversation]
      : conversation;
  const tools = toResponsesTools(options);
  const accountId = optionString(options, CODEX_ACCOUNT_ID_OPTION);
  const sessionId = optionString(options, CODEX_SESSION_ID_OPTION);

  const body: Record<string, unknown> = {
    model,
    input,
    instructions: codexInstructions(),
    // The Codex backend requires server-side storage off and streaming on, and
    // asks for encrypted reasoning so it can be round-tripped across turns.
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    parallel_tool_calls: false,
  };
  // The Codex backend rejects `max_output_tokens`; it is intentionally omitted.
  if (tools !== undefined) {
    body["tools"] = tools;
    body["tool_choice"] = "auto";
  }
  // reasoning_effort rides in providerOptions (same place the OpenAI-compatible
  // path reads it); map it onto the Responses `reasoning.effort` field.
  const effort = options.providerOptions?.["reasoning_effort"];
  if (typeof effort === "string" && effort !== "none") {
    body["reasoning"] = { effort, summary: "auto" };
  }
  if (sessionId !== undefined) body["prompt_cache_key"] = sessionId;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: BEARER_CREDENTIAL_SENTINEL,
    "openai-beta": "responses=experimental",
    originator: CODEX_ORIGINATOR,
  };
  if (accountId !== undefined) headers["chatgpt-account-id"] = accountId;
  if (sessionId !== undefined) headers["session_id"] = sessionId;

  return { url: CODEX_RESPONSES_PATH, headers, body: JSON.stringify(body) };
}

// ---------------------------------------------------------------------------
// Response parsing — Responses SSE events → internal inference events
// ---------------------------------------------------------------------------

// Per-request block indexing. The Responses stream tags every streaming item
// with an `item_id`, so we allocate one content-block index per distinct item
// id (regardless of kind). Keying by item id — rather than one sticky index per
// kind — preserves true arrival order when reasoning, text, and tool calls
// interleave, and lets `response.output_item.done` attach an encrypted-reasoning
// signature to the exact thinking block it belongs to. `kind` is recorded so a
// signature is only emitted against a real thinking block.
type CodexBlockKind = "text" | "thinking" | "tool_call";
export type CodexBlockIndexer = {
  nextIndex: number;
  items: Map<string, { index: number; kind: CodexBlockKind }>;
};

// Both the Codex and grok backends speak the same Responses SSE protocol, so
// the parser is shared. Each adapter creates its own indexer per request.
export function createResponsesBlockIndexer(): CodexBlockIndexer {
  return {
    nextIndex: 0,
    items: new Map<string, { index: number; kind: CodexBlockKind }>(),
  };
}

function blockIndexFor(
  state: CodexBlockIndexer,
  itemId: string,
  kind: CodexBlockKind,
): number {
  const existing = state.items.get(itemId);
  if (existing !== undefined) return existing.index;
  const index = state.nextIndex;
  state.nextIndex += 1;
  state.items.set(itemId, { index, kind });
  return index;
}

function usageFromResponse(
  response: Record<string, unknown>,
): TokenUsage | undefined {
  const usage = response["usage"];
  if (typeof usage !== "object" || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const inputDetails = u["input_tokens_details"] as
    | Record<string, unknown>
    | undefined;
  const outputDetails = u["output_tokens_details"] as
    | Record<string, unknown>
    | undefined;
  return {
    input: num(u["input_tokens"]),
    output: num(u["output_tokens"]),
    cacheRead: num(inputDetails?.["cached_tokens"]),
    cacheWrite: 0,
    thinking: num(outputDetails?.["reasoning_tokens"]),
  };
}

export function parseResponse(
  sseData: string,
  indexer: CodexBlockIndexer,
  source: LastCycleSource,
  label = "codex-responses",
): InferenceEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sseData);
  } catch (cause) {
    throw new ProtocolMismatchError(
      `${label} parseResponse: malformed JSON in SSE data payload: ${cause instanceof Error ? cause.message : String(cause)}`,
      sseData,
    );
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const event = parsed as Record<string, unknown>;
  const eventType = event["type"];
  if (typeof eventType !== "string") return [];

  const seq = 0;
  const events: InferenceEvent[] = [];

  switch (eventType) {
    case "response.output_text.delta": {
      const token = event["delta"];
      const itemId =
        typeof event["item_id"] === "string"
          ? (event["item_id"] as string)
          : "__text__";
      if (typeof token === "string" && token.length > 0) {
        events.push({
          type: "inference.text.delta",
          seq,
          data: {
            token,
            partial: EMPTY_PARTIAL,
            index: blockIndexFor(indexer, itemId, "text"),
          },
        });
      }
      return events;
    }
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta": {
      // Always register the block and emit a thinking delta (even for empty
      // tokens). This ensures a preceding thinking block exists for any
      // subsequent signature, supporting reasoning items whose visible
      // summary may be empty or delivered only via the done envelope.
      const token = event["delta"];
      const itemId =
        typeof event["item_id"] === "string"
          ? (event["item_id"] as string)
          : "__thinking__";
      const index = blockIndexFor(indexer, itemId, "thinking");
      const tok = typeof token === "string" ? token : "";
      events.push({
        type: "inference.thinking.delta",
        seq,
        data: { token: tok, partial: EMPTY_PARTIAL, index },
      });
      return events;
    }
    case "response.output_item.added": {
      const item = event["item"];
      if (typeof item === "object" && item !== null) {
        const it = item as Record<string, unknown>;
        if (it["type"] === "function_call") {
          const itemId = typeof it["id"] === "string" ? it["id"] : undefined;
          const callId = it["call_id"];
          const name = it["name"];
          if (
            itemId !== undefined &&
            typeof callId === "string" &&
            typeof name === "string"
          ) {
            events.push({
              type: "inference.tool_call.start",
              seq,
              data: {
                callId,
                name: decodeToolName(name),
                partial: EMPTY_PARTIAL,
                index: blockIndexFor(indexer, itemId, "tool_call"),
              },
            });
          }
        } else if (it["type"] === "reasoning") {
          // Pre-register reasoning items on added so the index is stable
          // even if no text deltas follow (pure-encrypted case).
          const itemId =
            typeof it["id"] === "string" ? (it["id"] as string) : undefined;
          if (itemId !== undefined) {
            const index = blockIndexFor(indexer, itemId, "thinking");
            events.push({
              type: "inference.thinking.delta",
              seq,
              data: { token: "", partial: EMPTY_PARTIAL, index },
            });
          }
        }
      }
      return events;
    }
    case "response.output_item.done": {
      // Capture the encrypted reasoning blob (signature) so it can be echoed
      // back on the next turn. Required for multi-turn continuity when the
      // backend uses store:false + reasoning.encrypted_content.
      // We ensure a thinking block exists (emitting an empty delta if this
      // is the first signal for the item) so the harness can attach the
      // signature without ProtocolMismatchError.
      const item = event["item"] as Record<string, unknown> | undefined;
      if (
        item?.["type"] === "reasoning" &&
        typeof item["id"] === "string" &&
        typeof item["encrypted_content"] === "string"
      ) {
        const itemId = item["id"] as string;
        const hadPrior = indexer.items.has(itemId);
        const index = blockIndexFor(indexer, itemId, "thinking");
        if (!hadPrior) {
          events.push({
            type: "inference.thinking.delta",
            seq,
            data: { token: "", partial: EMPTY_PARTIAL, index },
          });
        }
        events.push({
          type: "inference.thinking.signature",
          seq,
          data: { signature: item["encrypted_content"], index },
        });
      }
      return events;
    }
    case "response.function_call_arguments.delta": {
      const itemId = event["item_id"];
      const fragment = event["delta"];
      if (
        typeof itemId === "string" &&
        typeof fragment === "string" &&
        fragment.length > 0
      ) {
        const blockIndex = blockIndexFor(indexer, itemId, "tool_call");
        events.push({
          type: "inference.tool_call.delta",
          seq,
          // The harness routes argument fragments by a per-stream placeholder
          // keyed to the block index registered on the start event.
          data: {
            callId: String(blockIndex),
            argumentFragment: fragment,
            partial: EMPTY_PARTIAL,
            index: blockIndex,
          },
        });
      }
      return events;
    }
    case "response.completed": {
      const response = event["response"];
      if (typeof response === "object" && response !== null) {
        const usage = usageFromResponse(response as Record<string, unknown>);
        if (usage !== undefined) {
          events.push({
            type: "inference.usage",
            seq,
            data: { usage, source },
          });
        }
      }
      return events;
    }
    case "response.failed": {
      const response = event["response"] as Record<string, unknown> | undefined;
      const error = response?.["error"] as Record<string, unknown> | undefined;
      const message =
        typeof error?.["message"] === "string"
          ? error["message"]
          : "response failed";
      throw new ProtocolMismatchError(`${label}: ${message}`, parsed);
    }
    case "error": {
      const message =
        typeof event["message"] === "string"
          ? event["message"]
          : "stream error";
      throw new ProtocolMismatchError(`${label}: ${message}`, parsed);
    }
    default:
      // Lifecycle envelopes (response.created, response.in_progress,
      // content_part.*, *_text.done) carry no incremental payload the harness
      // needs; ignore them.
      return events;
  }
}

// The Responses stream ends on a semantic lifecycle event, not `[DONE]` or a
// socket close: `response.completed` on success, `response.incomplete` when the
// backend truncates, `response.done` as an alias some backends emit. The
// harness reads this to stop the loop once the terminal event is processed;
// failure envelopes (`response.failed`, `error`) already throw in
// `parseResponse`, which terminates the loop through the harness's catch.
const RESPONSES_TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.incomplete",
  "response.done",
]);

export function isResponsesStreamTerminal(sseData: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sseData);
  } catch {
    // parseResponse re-parses the same payload and raises the protocol error;
    // reporting "not terminal" here defers to that single throw site.
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const eventType = (parsed as Record<string, unknown>)["type"];
  return (
    typeof eventType === "string" && RESPONSES_TERMINAL_EVENTS.has(eventType)
  );
}

export function createCodexResponsesAdapter(
  source: LastCycleSource,
): ProviderAdapter {
  const indexer: CodexBlockIndexer = {
    nextIndex: 0,
    items: new Map<string, { index: number; kind: CodexBlockKind }>(),
  };
  return {
    buildRequest,
    parseResponse: (sseData) => parseResponse(sseData, indexer, source),
  };
}
