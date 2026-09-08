import { BEARER_CREDENTIAL_SENTINEL } from "@intx/inference";
import type { ConversationTurn, LastCycleSource } from "@intx/types/runtime";
import { type } from "arktype";
import { describe, expect, test } from "bun:test";
import { createXaiResponsesAdapter } from "./index";

// Pinned literally rather than imported: neither the CLI-proxy path nor the
// client-identification header values are on the package's public surface,
// and this test's job is to guard the exact wire bytes the proxy accepts,
// not to re-export more internals to reach them.
const RESPONSES_PATH = "/responses";
const CLIENT_IDENTIFIER = "grok-shell";
const CLIENT_VERSION = "0.2.93";
const USER_AGENT = "grok-shell/0.2.93 (macos; aarch64)";

const source: LastCycleSource = {
  sourceId: "test/xai",
  provider: "xai",
  model: "grok-4.5",
};
const turns: ConversationTurn[] = [
  { role: "user", timestamp: 0, content: [{ type: "text", text: "hi" }] },
];

// Narrows the parsed request body to the fields this test asserts, without
// an unsafe cast: a body missing or misshaping any of them throws rather
// than silently satisfying the type.
const RequestBody = type({
  input: "unknown[]",
  reasoning: { summary: "string", effort: "string" },
  prompt_cache_key: "string",
  store: "boolean",
  stream: "boolean",
});

// Guards the exact request shape xAI's CLI chat proxy accepts: the
// x-grok-* identification headers, the model-override header, the leading
// string-shaped system message, prompt_cache_key sourced from the
// session-id provider option, and reasoning effort forwarded only when the
// caller set it, and no max_output_tokens/temperature/parallel_tool_calls
// fields the proxy's own request never sends. A drift here (a renamed
// header, a system message that becomes content parts, a stray field) gets
// silently rejected or misinterpreted by the proxy rather than failing
// typecheck.
describe("createXaiResponsesAdapter", () => {
  test("produces the header set and body the xAI proxy accepts", () => {
    const adapter = createXaiResponsesAdapter(source);
    const request = adapter.buildRequest(turns, "grok-4.5", {
      systemPrompt: "be helpful",
      maxTokens: 4096,
      temperature: 0.7,
      providerOptions: {
        xaiUserId: "user-123",
        xaiSessionId: "session-456",
        xaiReasoningEffort: "high",
      },
    });

    expect(request.url).toBe(RESPONSES_PATH);
    expect(request.headers).toEqual({
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: BEARER_CREDENTIAL_SENTINEL,
      "user-agent": USER_AGENT,
      "x-grok-client-identifier": CLIENT_IDENTIFIER,
      "x-grok-client-version": CLIENT_VERSION,
      "x-grok-model-override": "grok-4.5",
      "x-grok-user-id": "user-123",
    });

    const parsed = RequestBody(JSON.parse(request.body));
    if (parsed instanceof type.errors) throw new Error(parsed.summary);

    expect(parsed.input).toEqual([
      { type: "message", role: "system", content: "be helpful" },
      { type: "message", role: "user", content: "hi" },
    ]);
    expect(parsed.reasoning).toEqual({ summary: "detailed", effort: "high" });
    expect(parsed.prompt_cache_key).toBe("session-456");
    expect(parsed.store).toBe(false);
    expect(parsed.stream).toBe(true);
    expect(parsed).not.toHaveProperty("parallel_tool_calls");
    expect(parsed).not.toHaveProperty("max_output_tokens");
    expect(parsed).not.toHaveProperty("temperature");
  });
});
