// Proves `createNoopInferenceRoutes()` serves a wire-valid Anthropic
// SSE stream: `POST /v1/messages` (whatever body, whatever — or no —
// `x-api-key`) returns a `message_start`/`content_block_start`/
// `content_block_delta`/`content_block_stop`/`message_delta`/
// `message_stop` sequence, parsed here with the exact `parseSSE` byte
// framing and the exact per-event arktype schemas
// `vendor/intx/inference/src/providers/anthropic.ts` uses to accept
// real Anthropic traffic — so a drift in this endpoint's shape shows
// up here, not only when a real channel host tries to use it.
import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import { createNoopInferenceRoutes } from "../src/noop-inference";

const ContentBlockDelta = type({
  type: "'content_block_delta'",
  index: "number",
  delta: { type: "string", "text?": "string" },
});
const ContentBlockStart = type({
  type: "'content_block_start'",
  index: "number",
  "content_block?": { type: "string" },
});
const ContentBlockStop = type({
  type: "'content_block_stop'",
  index: "number",
});
const MessageDelta = type({
  type: "'message_delta'",
  "usage?": { "output_tokens?": "number" },
});
const MessageStart = type({
  type: "'message_start'",
  "message?": {
    "usage?": {
      "input_tokens?": "number",
      "output_tokens?": "number",
      "cache_read_input_tokens?": "number",
      "cache_creation_input_tokens?": "number",
    },
  },
});
const MessageStop = type({ type: "'message_stop'" });

const AnthropicSSEEvent = ContentBlockDelta.or(ContentBlockStart)
  .or(ContentBlockStop)
  .or(MessageDelta)
  .or(MessageStart)
  .or(MessageStop);

async function readSSEEvents(response: Response): Promise<unknown[]> {
  const text = await response.text();
  const payloads = text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => chunk.replace(/^data:\s?/, ""));
  return payloads.map((payload) => JSON.parse(payload));
}

describe("createNoopInferenceRoutes", () => {
  test("serves a parseable Anthropic-shaped SSE stream for any body and no x-api-key", async () => {
    const app = createNoopInferenceRoutes();

    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = await readSSEEvents(response);
    expect(events).toHaveLength(6);

    const parsed = events.map((event) => {
      const result = AnthropicSSEEvent(event);
      if (result instanceof type.errors) {
        throw new Error(
          `event failed the Anthropic SSE schema: ${result.summary}`,
        );
      }
      return result;
    });

    expect(parsed.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const messageStart = parsed[0] as {
      type: "message_start";
      message?: { usage?: { input_tokens?: number; output_tokens?: number } };
    };
    expect(messageStart.message?.usage?.input_tokens).toBe(0);
    expect(messageStart.message?.usage?.output_tokens).toBe(0);

    const delta = parsed[2] as {
      type: "content_block_delta";
      index: number;
      delta: { type: string; text?: string };
    };
    expect(delta.index).toBe(0);
    expect(delta.delta.type).toBe("text_delta");
    // Deliberately empty — see `noop-inference.ts`'s own doc: a
    // non-empty delta would make `connector.reply` treat this as a
    // real reply and post it into the channel's mailbox.
    expect(delta.delta.text).toBe("");

    const usageDelta = parsed[4] as {
      type: "message_delta";
      usage?: { output_tokens?: number };
    };
    expect(usageDelta.usage?.output_tokens).toBeGreaterThan(0);
  });

  test("accepts a request carrying an arbitrary x-api-key exactly the same as one carrying none", async () => {
    const app = createNoopInferenceRoutes();

    const withKey = await app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "not-checked-at-all" },
      body: "{}",
    });
    const withoutKey = await app.request("/v1/messages", {
      method: "POST",
      body: "{}",
    });

    expect(withKey.status).toBe(200);
    expect(withoutKey.status).toBe(200);
    expect(await readSSEEvents(withKey)).toEqual(
      await readSSEEvents(withoutKey),
    );
  });
});
