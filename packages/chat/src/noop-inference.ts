// A hub-served stand-in for a real Anthropic endpoint, spoken by
// agents that must never produce text: `workflows/heartbeat` and
// `workflows/workbench-digest` pin their `ModelSource` here (see
// `@corbits/seeding`'s `seed.ts`) so their scheduled turns complete
// instantly against a constant empty reply instead of burning a live
// model call whose output would be discarded.
//
// The wire shape matches exactly what `@intx/inference/src/providers/anthropic.ts`'s
// `parseResponse` accepts (see that file's `AnthropicSSEEvent` union,
// ~line 490-560): `message_start` (with zeroed usage), one
// `content_block_start` at index 0, one `content_block_delta` carrying
// a `text_delta`, `content_block_stop`, `message_delta` (with a
// nonzero `output_tokens` so downstream usage accounting sees a real
// number), then `message_stop`. `@intx/inference`'s `parseSSE` (see
// that file) needs no `[DONE]` sentinel — the stream simply ends.
//
// The delta's text is deliberately empty, not merely short: an empty
// reply is exactly the posture a real model obeying "never reply"
// would earn by producing no text, so nothing downstream mistakes the
// constant for a real answer.
import { Hono } from "hono";

const NOOP_REPLY_TEXT = "";

function sseLine(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * `POST /v1/messages` — the same path `buildRequest` posts to
 * (`{baseURL}/v1/messages`) — accepting any body and any `x-api-key`
 * (including none) and always returning the same constant SSE stream.
 * No auth check is safe here specifically because the handler takes no
 * action, reads no state, and returns a constant: there is nothing an
 * attacker could use this endpoint to do, see, or change regardless of
 * what credential (if any) they present.
 */
export function createNoopInferenceRoutes(): Hono {
  const app = new Hono();

  app.post("/v1/messages", (_c) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const events: Record<string, unknown>[] = [
          {
            type: "message_start",
            message: {
              usage: {
                input_tokens: 0,
                output_tokens: 0,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: NOOP_REPLY_TEXT },
          },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", usage: { output_tokens: 1 } },
          { type: "message_stop" },
        ];
        for (const event of events) {
          controller.enqueue(encoder.encode(sseLine(event)));
        }
        controller.close();
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
  });

  return app;
}
