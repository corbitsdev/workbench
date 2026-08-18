import { afterEach, describe, expect, test } from "bun:test";

import { openAgentDmChat } from "./agent-dm-launch";

describe("openAgentDmChat", () => {
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

  test("opens the agent's DM with reuseExisting and navigates to it", async () => {
    const navigated: string[] = [];
    const calls = stubFetch((path) => {
      if (path.endsWith("/chat/workbenches")) {
        return json({
          id: "chan-dm-1",
          title: "Outreach",
          kind: "chat",
          pinned: false,
          participants: [],
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    await openAgentDmChat("tnt_root", "wfd_outreach", (to) =>
      navigated.push(to),
    );

    const call = calls.find((c) => c.path.endsWith("/chat/workbenches"));
    expect(call?.path).toBe("/api/tenants/tnt_root/chat/workbenches");
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      kind: "chat",
      definitionId: "wfd_outreach",
      reuseExisting: true,
    });
    expect(navigated).toEqual(["/w/chan-dm-1"]);
  });

  test("mints in the definition's owning tenant, not necessarily the caller's own", async () => {
    const calls = stubFetch(() =>
      json({
        id: "chan-dm-2",
        title: "Outreach",
        kind: "chat",
        pinned: false,
        participants: [],
      }),
    );

    await openAgentDmChat("tnt_ancestor", "wfd_outreach", () => {});

    expect(calls[0]?.path).toBe("/api/tenants/tnt_ancestor/chat/workbenches");
  });
});
