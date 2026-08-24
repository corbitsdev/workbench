import { afterEach, describe, expect, test } from "bun:test";

import { launchAgentChat } from "./agent-chat-launch";

describe("launchAgentChat", () => {
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

  test("opens a chat for the given definitionId and navigates to it", async () => {
    const navigated: string[] = [];
    const calls = stubFetch((path) => {
      if (path.endsWith("/chat/workbenches")) {
        return json({
          id: "chan-1",
          title: "Echo",
          kind: "chat",
          pinned: false,
          participants: [],
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    await launchAgentChat("tnt_1", "wfd_echo", (to) => navigated.push(to));

    const call = calls.find((c) => c.path.endsWith("/chat/workbenches"));
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      kind: "chat",
      definitionId: "wfd_echo",
    });
    expect(navigated).toEqual(["/w/chan-1"]);
  });

  test("passes an explicit name through when given one", async () => {
    const calls = stubFetch((path) => {
      if (path.endsWith("/chat/workbenches")) {
        return json({
          id: "chan-2",
          title: "New Workbench",
          kind: "chat",
          pinned: false,
          participants: [],
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    await launchAgentChat("tnt_1", "wfd_assistant", () => {}, "New Workbench");

    const call = calls.find((c) => c.path.endsWith("/chat/workbenches"));
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      kind: "chat",
      definitionId: "wfd_assistant",
      name: "New Workbench",
    });
  });
});
