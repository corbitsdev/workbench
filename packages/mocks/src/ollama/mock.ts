import { type } from "arktype";
import { CapturedChatRequest, CapturedRequestLog } from "./capture";
import { createAdversarialReplies } from "./scenarios";
import {
  ChatCompletionRequestBody,
  type OllamaCatalogEntry,
  type OllamaChatReply,
  type OllamaToolCall,
} from "./types";

export type OllamaChatHandler = (
  request: CapturedChatRequest,
) => OllamaChatReply;

export type CreateOllamaMockOptions = {
  /** The `/api/tags` catalogue served before any `onChat` handler runs.
   * Change it mid-test with `setModels` to exercise a connect flow that
   * (re)reads the catalogue. */
  readonly models?: readonly OllamaCatalogEntry[];
};

export type OllamaMockServer = {
  readonly url: string;
  close(): Promise<void>;
};

function defaultReply(): OllamaChatReply {
  return { text: "mock reply", finishReason: "stop" };
}

function toolCallToWire(call: OllamaToolCall, index: number) {
  return {
    id: `call_${index}`,
    type: "function" as const,
    function: {
      name: call.name,
      arguments: call.rawArguments ?? JSON.stringify(call.arguments),
    },
  };
}

function replyMessage(reply: OllamaChatReply) {
  const toolCalls = reply.toolCalls?.map(toolCallToWire);
  return {
    role: "assistant" as const,
    content: reply.text ?? null,
    ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
  };
}

function finishReasonOf(reply: OllamaChatReply): string {
  return (
    reply.finishReason ??
    (reply.toolCalls !== undefined && reply.toolCalls.length > 0
      ? "tool_calls"
      : "stop")
  );
}

function nonStreamingResponse(model: string, reply: OllamaChatReply): Response {
  const body = {
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: replyMessage(reply),
        finish_reason: finishReasonOf(reply),
      },
    ],
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// A single-chunk SSE stream carrying the whole reply, then `[DONE]` — real
// Ollama and OpenAI both emit the assistant content across many deltas,
// but this mock's contract is the request it received and the shape of
// the reply, not reproducing token-by-token pacing.
function streamingResponse(model: string, reply: OllamaChatReply): Response {
  const chunk = {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content: reply.text ?? null,
          ...(reply.toolCalls !== undefined
            ? { tool_calls: reply.toolCalls.map(toolCallToWire) }
            : {}),
        },
        finish_reason: null,
      },
    ],
  };
  const doneChunk = {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReasonOf(reply) }],
  };
  const body =
    `data: ${JSON.stringify(chunk)}\n\n` +
    `data: ${JSON.stringify(doneChunk)}\n\n` +
    `data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export class OllamaMock {
  readonly requests = new CapturedRequestLog();
  private models: OllamaCatalogEntry[];
  private handler: OllamaChatHandler = defaultReply;

  constructor(options: CreateOllamaMockOptions = {}) {
    this.models = [...(options.models ?? [])];
  }

  setModels(models: readonly OllamaCatalogEntry[]): void {
    this.models = [...models];
  }

  /** Scripts the reply to every `/v1/chat/completions` request from now
   * on. Called once per request, so a handler can vary its reply by
   * turn count (`this.requests.count`) or by inspecting the captured
   * request it's handed. */
  onChat(handler: OllamaChatHandler): void {
    this.handler = handler;
  }

  reply = {
    text: (text: string): OllamaChatReply => ({ text, finishReason: "stop" }),
    toolCall: (name: string, args: unknown): OllamaChatReply => ({
      toolCalls: [{ name, arguments: args }],
      finishReason: "tool_calls",
    }),
    toolCalls: (calls: readonly OllamaToolCall[]): OllamaChatReply => ({
      toolCalls: calls,
      finishReason: "tool_calls",
    }),
    ...createAdversarialReplies(),
  };

  /**
   * The whole mock as a `fetch`-shaped function — `(input, init?)`, the
   * same two-argument shape as global `fetch` and, load-bearingly,
   * `@corbits/connections`'s `FetchLike` (the seam every real caller —
   * `testProviderCredential`, `fetchOllamaModelCatalog`,
   * `fetchOllamaModelCapabilities` — actually threads a `fetchImpl`
   * through as). A caller passing a bare `Request`
   * (`ollama.fetch(new Request(...))`) still works; the common case is a
   * URL string plus an init object, exactly what those functions build.
   */
  fetch = async (
    input: string | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request =
      input instanceof Request
        ? init === undefined
          ? input
          : new Request(input, init)
        : new Request(input, init);
    return this.route(request);
  };

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/tags") {
      return this.handleTags();
    }
    if (request.method === "POST" && url.pathname === "/api/show") {
      return this.handleShow(await request.json());
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      return this.handleChatCompletions(await request.json());
    }
    return new Response(
      JSON.stringify({
        error: `mock ollama has no route for ${request.method} ${url.pathname}`,
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }

  private handleTags(): Response {
    const body = {
      models: this.models.map((m) => ({
        name: m.name,
        digest: m.digest ?? `sha256:mock-${m.name}`,
        size: m.size ?? 0,
      })),
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  private handleShow(rawBody: unknown): Response {
    const ShowRequest = type({ model: "string" });
    const parsed = ShowRequest(rawBody);
    if (parsed instanceof type.errors) {
      return new Response(JSON.stringify({ error: parsed.summary }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const entry = this.models.find((m) => m.name === parsed.model);
    return new Response(
      JSON.stringify({ capabilities: entry?.capabilities ?? [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  private handleChatCompletions(rawBody: unknown): Response {
    const parsed = ChatCompletionRequestBody(rawBody);
    if (parsed instanceof type.errors) {
      return new Response(
        JSON.stringify({
          error: `malformed chat-completions request: ${parsed.summary}`,
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    const captured = new CapturedChatRequest(parsed);
    this.requests.push(captured);
    const reply = this.handler(captured);
    return parsed.stream
      ? streamingResponse(parsed.model, reply)
      : nonStreamingResponse(parsed.model, reply);
  }

  /** Starts a real HTTP server (Bun) and returns its URL — for the e2e
   * path, where the stack is pointed at an Ollama origin via env rather
   * than an in-process fetch. */
  async listen(port = 0): Promise<OllamaMockServer> {
    const server = Bun.serve({ port, fetch: (request) => this.route(request) });
    return {
      url: `http://localhost:${server.port}`,
      close: async () => {
        server.stop(true);
      },
    };
  }
}

export function createOllamaMock(
  options?: CreateOllamaMockOptions,
): OllamaMock {
  return new OllamaMock(options);
}
