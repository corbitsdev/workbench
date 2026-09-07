import { afterEach, describe, expect, test } from "bun:test";

import { createDefaultAgentWorkbench } from "./default-agent-workbench";

type StubDefinition = { readonly id: string; readonly name: string };

function definition(id: string, name: string): StubDefinition {
  return { id, name };
}

describe("createDefaultAgentWorkbench", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  type RecordedCall = { readonly path: string; readonly init?: RequestInit };

  function stubFetch(respond: (path: string) => Response): RecordedCall[] {
    const calls: RecordedCall[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        typeof input === "string" ? input : new URL(String(input)).pathname;
      calls.push(init === undefined ? { path } : { path, init });
      return Promise.resolve(respond(path));
    }) as typeof fetch;
    return calls;
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  test("isCachedWorkbenchId is false until a workbench id is cached", () => {
    const agent = createDefaultAgentWorkbench({
      title: "Myra",
      assetName: "assistant",
    });
    expect(agent.isCachedWorkbenchId("chan-1")).toBe(false);
    expect(agent.isCachedWorkbenchId(null)).toBe(false);
  });

  test("ensure issues exactly the definition-keyed create, with no list-by-title lookup", async () => {
    const agent = createDefaultAgentWorkbench({
      title: "Myra",
      assetName: "assistant",
    });
    const calls = stubFetch((path) => {
      if (path.endsWith("/chat/workbenches")) {
        return json({
          id: "chat-1",
          title: "Myra",
          kind: "chat",
          pinned: false,
          participants: [],
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    const result = await agent.ensure("tnt_1", async () => [
      definition("def-assistant", "assistant"),
    ]);

    expect(result).toEqual({ kind: "ready", workbenchId: "chat-1" });
    expect(calls).toHaveLength(1);
    const createCall = calls[0];
    expect(createCall?.path.endsWith("/chat/workbenches")).toBe(true);
    expect(createCall?.init?.method).toBe("POST");
    expect(JSON.parse(String(createCall?.init?.body))).toEqual({
      kind: "chat",
      definitionId: "def-assistant",
      name: "Myra",
      reuseExisting: true,
    });
    expect(agent.isCachedWorkbenchId("chat-1")).toBe(true);
  });

  test("errors when no definition matches the configured asset name", async () => {
    const agent = createDefaultAgentWorkbench({
      title: "Myra",
      assetName: "assistant",
    });

    const result = await agent.ensure("tnt_1", async () => [
      definition("def-echo", "echo"),
    ]);

    expect(result.kind).toBe("error");
  });

  test("errors when the configured asset name is undefined", async () => {
    const agent = createDefaultAgentWorkbench({
      title: "Myra",
      assetName: undefined,
    });

    const result = await agent.ensure("tnt_1", async () => [
      definition("def-echo", "echo"),
    ]);

    expect(result.kind).toBe("error");
  });

  test("resetCache clears the cached id", async () => {
    const agent = createDefaultAgentWorkbench({
      title: "Myra",
      assetName: "assistant",
    });
    stubFetch((path) => {
      if (path.endsWith("/chat/workbenches")) {
        return json({
          id: "chat-1",
          title: "Myra",
          kind: "chat",
          pinned: false,
          participants: [],
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    await agent.ensure("tnt_1", async () => [
      definition("def-assistant", "assistant"),
    ]);
    expect(agent.isCachedWorkbenchId("chat-1")).toBe(true);
    agent.resetCache();
    expect(agent.isCachedWorkbenchId("chat-1")).toBe(false);
  });
});
