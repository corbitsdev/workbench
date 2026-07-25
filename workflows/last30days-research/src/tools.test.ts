import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@intx/agent";
import {
  createLazySafeCredentialedTool,
  createSafeKeylessTools,
  wrapSafeStringTool,
  SAFE_EXA_SEARCH_DEFINITION,
  SAFE_HACKERNEWS_SEARCH_DEFINITION,
  SAFE_POLYMARKET_ODDS_DEFINITION,
} from "./tools";

const SIGNAL = new AbortController().signal;

function fakeStringTool(handler: AgentTool["handler"]): AgentTool {
  return {
    kind: "string",
    definition: {
      name: "underlying_source_tool",
      description: "fake underlying source",
      inputSchema: { type: "object", properties: {} },
    },
    handler: handler as (
      args: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<string>,
  };
}

describe("wrapSafeStringTool", () => {
  test("a thrown handler error degrades to a SUCCESSFUL result whose string body is a JSON { isError: true, error } envelope", async () => {
    // This is the exact contract `runDeterministicToolStep` requires: it
    // throws and fails the run whenever the dispatched tool's OUTER
    // `ToolResult.isError` comes back true (`apps/sidecar/src/
    // step-tool-harness.ts`), with no `nonFatal` escape for the native
    // `action` primitive. So the wrapper must never let the underlying
    // throw propagate as an outer error — it must swallow it and report the
    // failure as DATA inside a successful string result.
    const underlying = fakeStringTool(() =>
      Promise.reject(new Error("rate limited: 429")),
    );
    const wrapped = wrapSafeStringTool(underlying, "safe_name", "safe desc");
    if (wrapped.kind !== "string") throw new Error("expected string tool");

    // The wrapper's handler resolves — it never rejects/throws.
    const result = await wrapped.handler({ query: "q" }, SIGNAL);
    expect(typeof result).toBe("string");

    const parsed = JSON.parse(result) as { isError: boolean; error: string };
    expect(parsed.isError).toBe(true);
    expect(parsed.error).toBe("rate limited: 429");
  });

  test("a successful underlying call passes its string output straight through, unmodified", async () => {
    const payload = JSON.stringify([{ url: "https://example.com" }]);
    const underlying = fakeStringTool(() => Promise.resolve(payload));
    const wrapped = wrapSafeStringTool(underlying, "safe_name", "safe desc");
    if (wrapped.kind !== "string") throw new Error("expected string tool");

    const result = await wrapped.handler({ query: "q" }, SIGNAL);
    expect(result).toBe(payload);
  });

  test("the wrapped definition takes the new name/description but keeps the underlying input schema", () => {
    const underlying = fakeStringTool(() => Promise.resolve("[]"));
    const wrapped = wrapSafeStringTool(underlying, "safe_name", "safe desc");
    expect(wrapped.definition.name).toBe("safe_name");
    expect(wrapped.definition.description).toBe("safe desc");
    expect(wrapped.definition.inputSchema).toEqual(
      underlying.definition.inputSchema,
    );
  });

  test('refuses to wrap a kind:"full" tool (only kind:"string" source tools are supported)', () => {
    const fullTool: AgentTool = {
      kind: "full",
      definition: {
        name: "full_tool",
        description: "d",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async (call) => ({ callId: call.id, content: "x" }),
    };
    expect(() => wrapSafeStringTool(fullTool, "safe", "d")).toThrow();
  });
});

describe("createLazySafeCredentialedTool", () => {
  test("a missing tenant credential degrades to a completed { isError: true } envelope, never a throw", async () => {
    // Regression guard for the eager-construction trap: this tool must be
    // buildable with NO credential in env (factory construction always
    // succeeds), and calling its handler with the credential still absent
    // must resolve to the wrapper's own error envelope rather than
    // rejecting/throwing (a throw here would surface as
    // StepToolCredentialMissingError, strictly worse than the nonFatal
    // behavior this migration replaces).
    const buildSafeTools = () => {
      throw new Error("buildSafeTools must not be called with no credential");
    };
    const factory = createLazySafeCredentialedTool({
      provider: "exa",
      definition: SAFE_EXA_SEARCH_DEFINITION,
      buildSafeTools,
    });

    // No `workbench.cred.exa` key in env — the tenant has not configured Exa.
    const tool = factory({});
    if (tool.kind !== "string") throw new Error("expected string tool");

    const result = await tool.handler({ query: "q" }, SIGNAL);
    expect(typeof result).toBe("string");
    const parsed = JSON.parse(result) as { isError: boolean; error: string };
    expect(parsed.isError).toBe(true);
    expect(parsed.error).toContain("exa");
  });

  test("a configured credential is resolved lazily and the underlying safe tool's result passes through", async () => {
    const payload = JSON.stringify([{ url: "https://example.com" }]);
    const safeTool: AgentTool = {
      kind: "string",
      definition: SAFE_EXA_SEARCH_DEFINITION,
      handler: async () => payload,
    };
    const factory = createLazySafeCredentialedTool({
      provider: "exa",
      definition: SAFE_EXA_SEARCH_DEFINITION,
      buildSafeTools: () => [safeTool],
    });

    const tool = factory({
      "workbench.cred.exa": { apiKey: "k", baseURL: "https://exa.example" },
    });
    if (tool.kind !== "string") throw new Error("expected string tool");

    const result = await tool.handler({ query: "q" }, SIGNAL);
    expect(result).toBe(payload);
  });
});

describe("createSafeKeylessTools", () => {
  test("builds both keyless wrappers without a credential", () => {
    const tools = createSafeKeylessTools();
    const names = tools.map((t) => t.definition.name).sort();
    expect(names).toEqual(
      [
        SAFE_HACKERNEWS_SEARCH_DEFINITION.name,
        SAFE_POLYMARKET_ODDS_DEFINITION.name,
      ].sort(),
    );
  });
});
