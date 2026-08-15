import { afterEach, describe, expect, test } from "bun:test";

import {
  createAgentAndLaunch,
  DEFAULT_AGENT_NAME,
  handleAttempt,
} from "./instant-agent-create";

describe("handleAttempt", () => {
  test("the first attempt keeps the bare handle", () => {
    expect(handleAttempt("new-agent", 0)).toBe("new-agent");
  });

  test("later attempts number the handle", () => {
    expect(handleAttempt("new-agent", 1)).toBe("new-agent-2");
    expect(handleAttempt("new-agent", 2)).toBe("new-agent-3");
  });
});

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

  const definitionWire = {
    id: "def-1",
    tenantId: "tnt_1",
    name: DEFAULT_AGENT_NAME,
    currentVersion: "1",
    status: "deployed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    skills: [] as readonly string[],
  };

  test("drafts, creates with the default name's handle, and launches the chat", async () => {
    const navigated: string[] = [];
    const calls = stubFetch((path) => {
      if (path.endsWith("/planner/agent-definitions/draft")) {
        return json({ draft: { systemPrompt: "You are New agent." } });
      }
      if (path.endsWith("/agent-definitions")) {
        return json(definitionWire);
      }
      if (path.endsWith("/chat/channels")) {
        return json({
          id: "chan-1",
          title: DEFAULT_AGENT_NAME,
          kind: "chat",
          pinned: false,
          participants: [],
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    await createAgentAndLaunch("tnt_1", (to) => navigated.push(to));

    const createCall = calls.find((call) =>
      call.path.endsWith("/agent-definitions"),
    );
    expect(JSON.parse(String(createCall?.init?.body))).toEqual({
      name: DEFAULT_AGENT_NAME,
      handle: "new-agent",
      systemPrompt: "You are New agent.",
    });
    expect(navigated).toEqual(["/c/chan-1"]);
  });

  test("retries with a numbered handle on a 409 conflict", async () => {
    const navigated: string[] = [];
    let createAttempts = 0;
    stubFetch((path) => {
      if (path.endsWith("/planner/agent-definitions/draft")) {
        return json({ draft: { systemPrompt: "You are New agent." } });
      }
      if (path.endsWith("/agent-definitions")) {
        createAttempts += 1;
        return createAttempts === 1
          ? json({ error: "handle taken" }, 409)
          : json(definitionWire);
      }
      if (path.endsWith("/chat/channels")) {
        return json({
          id: "chan-2",
          title: DEFAULT_AGENT_NAME,
          kind: "chat",
          pinned: false,
          participants: [],
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    await createAgentAndLaunch("tnt_1", (to) => navigated.push(to));

    expect(createAttempts).toBe(2);
    expect(navigated).toEqual(["/c/chan-2"]);
  });
});
