import { afterEach, describe, expect, test } from "bun:test";

import {
  createWorkbenchFromTemplate,
  NEW_WORKBENCH_TITLE,
} from "./instant-agent-create";

describe("createWorkbenchFromTemplate (CL-6387)", () => {
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

  // The picker's "Create workbench" is clickable more than once per
  // session (a second visit, a second row) — each click must mint its
  // own, genuinely distinct workbench, never reopen or alias the last
  // one it created.
  test("picking the same row twice in a row mints two distinct workbenches, not one reused", async () => {
    let nextId = 0;
    const navigated: string[] = [];
    const calls = stubFetch((path) => {
      if (path.includes("/workflows/definitions")) {
        return json({ data: [assistantDefinitionWire], nextCursor: null });
      }
      if (path.endsWith("/chat/workbenches")) {
        nextId += 1;
        return json({
          id: `chan-${nextId}`,
          title: NEW_WORKBENCH_TITLE,
          kind: "chat",
          pinned: false,
          participants: [],
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    await createWorkbenchFromTemplate("tnt_1", "blank", (to) =>
      navigated.push(to),
    );
    await createWorkbenchFromTemplate("tnt_1", "blank", (to) =>
      navigated.push(to),
    );

    const createCalls = calls.filter((call) =>
      call.path.endsWith("/chat/workbenches"),
    );
    expect(createCalls).toHaveLength(2);
    expect(navigated).toEqual(["/w/chan-1", "/w/chan-2"]);
    expect(navigated[0]).not.toBe(navigated[1]);
  });
});
