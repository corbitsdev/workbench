import { afterEach, describe, expect, test } from "bun:test";

import {
  createAgentAndLaunch,
  NEW_WORKBENCH_TITLE,
} from "./instant-agent-create";

describe("createAgentAndLaunch", () => {
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

  const assistantDefinitionWire = {
    id: "def-assistant",
    tenantId: "tnt_1",
    name: "assistant",
    currentVersion: "1",
    status: "deployed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    skills: [] as readonly string[],
  };

  test("launches a New Workbench chat against the default setup template, no definition drafted", async () => {
    const navigated: string[] = [];
    const calls = stubFetch((path) => {
      if (path.includes("/workflows/definitions")) {
        return json({ data: [assistantDefinitionWire], nextCursor: null });
      }
      if (path.endsWith("/chat/channels")) {
        return json({
          id: "chan-1",
          title: NEW_WORKBENCH_TITLE,
          kind: "chat",
          pinned: false,
          participants: [],
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    await createAgentAndLaunch("tnt_1", (to) => navigated.push(to));

    const createCall = calls.find((call) =>
      call.path.endsWith("/chat/channels"),
    );
    expect(JSON.parse(String(createCall?.init?.body))).toEqual({
      kind: "chat",
      definitionId: "def-assistant",
      name: NEW_WORKBENCH_TITLE,
    });
    expect(calls.some((call) => call.path.includes("/agent-definitions"))).toBe(
      false,
    );
    expect(navigated).toEqual(["/c/chan-1"]);
  });

  test("throws when the tenant has no deployed setup template", async () => {
    stubFetch((path) => {
      if (path.includes("/workflows/definitions")) {
        return json({ data: [], nextCursor: null });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    await expect(createAgentAndLaunch("tnt_1", () => {})).rejects.toThrow(
      "No default setup agent found for this workbench.",
    );
  });
});
