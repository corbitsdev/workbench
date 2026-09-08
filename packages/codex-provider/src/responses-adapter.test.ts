import type { ConversationTurn, LastCycleSource } from "@intx/types/runtime";
import { type } from "arktype";
import { describe, expect, test } from "bun:test";
import { createCodexResponsesAdapter, CodexQuirksError } from "./index";

const source: LastCycleSource = {
  sourceId: "test/codex",
  provider: "codex",
  model: "gpt-5.5",
};
const turns: ConversationTurn[] = [
  { role: "user", timestamp: 0, content: [{ type: "text", text: "hi" }] },
];
const quirks = {
  productName: "Acme Code",
  environmentTagName: "acme_environment",
};

const CodexRequestBody = type({
  "store?": "boolean",
  "parallel_tool_calls?": "boolean",
  "prompt_cache_key?": "string",
  "max_output_tokens?": "number",
  "instructions?": "string",
  "input?": type({
    role: "string",
    "content?": type({ "text?": "string" }).array(),
  }).array(),
  "reasoning?": type({ "effort?": "string" }),
});

function parseCodexBody(rawBody: string) {
  const parsed = CodexRequestBody(JSON.parse(rawBody));
  if (parsed instanceof type.errors) throw new Error(parsed.summary);
  return parsed;
}

// Guards the exact request shape the Codex ChatGPT backend accepts: the
// chatgpt-account-id header only rides when the option is set, session_id
// rides in both the header and the body, `instructions` is omitted (the
// host's own system prompt leads `input` as a wrapped developer message),
// and the three fields the backend requires explicit values for (`store`,
// `parallel_tool_calls`, `max_output_tokens`) are on the wire correctly.
describe("Codex responses adapter — request shape", () => {
  test("throws a CodexQuirksError when the quirks bag is absent — there is no honest default product name", () => {
    let error: unknown;
    try {
      createCodexResponsesAdapter(source, undefined);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CodexQuirksError);
    expect((error as Error).name).toBe("CodexQuirksError");
    expect((error as Error).message).toContain("productName");
  });

  test("includes the account id header only when the option is set", () => {
    const adapter = createCodexResponsesAdapter(source, quirks);
    const withAccount = adapter.buildRequest(turns, "gpt-5.5", {
      providerOptions: { codexAccountId: "acct-1" },
    });
    expect(withAccount.headers["chatgpt-account-id"]).toBe("acct-1");

    const withoutAccount = adapter.buildRequest(turns, "gpt-5.5", {});
    expect(withoutAccount.headers["chatgpt-account-id"]).toBeUndefined();
  });

  test("sends the session id in both the body and the header", () => {
    const adapter = createCodexResponsesAdapter(source, quirks);
    const request = adapter.buildRequest(turns, "gpt-5.5", {
      providerOptions: { codexSessionId: "session-1" },
    });
    expect(request.headers["session_id"]).toBe("session-1");
    const body = parseCodexBody(request.body);
    expect(body.prompt_cache_key).toBe("session-1");
  });

  test("omits instructions and carries the host prompt as a bridged developer message", () => {
    const adapter = createCodexResponsesAdapter(source, quirks);
    const request = adapter.buildRequest(turns, "gpt-5.5", {
      systemPrompt: "operate carefully",
    });
    const body = parseCodexBody(request.body);

    expect(body.instructions).toBeUndefined();
    expect(body.input?.[0]?.role).toBe("developer");
    const bridgeText = body.input?.[0]?.content?.[0]?.text ?? "";
    expect(bridgeText).toContain(
      "Acme Code is the harness, not the Codex CLI.",
    );
    expect(bridgeText).toContain("operate carefully");
  });

  test("always sends store:false and parallel_tool_calls:false, and omits max_output_tokens", () => {
    const adapter = createCodexResponsesAdapter(source, quirks);
    const request = adapter.buildRequest(turns, "gpt-5.5", { maxTokens: 4096 });
    const body = parseCodexBody(request.body);

    expect(body.store).toBe(false);
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.max_output_tokens).toBeUndefined();
  });

  test("omits reasoning.effort when the caller requests no reasoning", () => {
    const adapter = createCodexResponsesAdapter(source, quirks);
    const noneRequest = adapter.buildRequest(turns, "gpt-5.5", {
      providerOptions: { codexReasoningEffort: "none" },
    });
    expect(parseCodexBody(noneRequest.body).reasoning).toBeUndefined();

    const highRequest = adapter.buildRequest(turns, "gpt-5.5", {
      providerOptions: { codexReasoningEffort: "high" },
    });
    expect(parseCodexBody(highRequest.body).reasoning).toEqual({
      effort: "high",
    });
  });
});
