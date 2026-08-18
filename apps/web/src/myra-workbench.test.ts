import { afterEach, describe, expect, test } from "bun:test";

import {
  ensureMyraWorkbench,
  findMyraWorkbench,
  findMyraDefinition,
  isMyraWorkbenchId,
  isMyraWorkbenchTitle,
  MYRA_WORKBENCH_TITLE,
  resetMyraWorkbenchCache,
} from "./myra-workbench";
import type { Workbench } from "@corbits/chat-ui";
import type { AgentDefinition } from "./agents-api";

function workbench(partial: {
  readonly id: string;
  readonly title: string;
  readonly kind?: string;
}): Workbench {
  return {
    id: partial.id,
    title: partial.title,
    kind: partial.kind ?? "workbench",
    pinned: false,
    participants: [],
  };
}

describe("myra-workbench helpers", () => {
  afterEach(() => {
    resetMyraWorkbenchCache();
  });

  test("isMyraWorkbenchId is false until a workbench id is cached", () => {
    expect(isMyraWorkbenchId("chan-1")).toBe(false);
    expect(isMyraWorkbenchId(null)).toBe(false);
  });

  test("MYRA_WORKBENCH_TITLE is Myra", () => {
    expect(MYRA_WORKBENCH_TITLE).toBe("Myra");
  });

  test("isMyraWorkbenchTitle is case-insensitive and trims", () => {
    expect(isMyraWorkbenchTitle("Myra")).toBe(true);
    expect(isMyraWorkbenchTitle(" myra ")).toBe(true);
    expect(isMyraWorkbenchTitle("MYRA")).toBe(true);
    expect(isMyraWorkbenchTitle("Myra chat")).toBe(false);
    expect(isMyraWorkbenchTitle("Assistant")).toBe(false);
  });

  test("findMyraWorkbench returns the first Myra-titled row", () => {
    const items = [
      workbench({ id: "a", title: "general" }),
      workbench({ id: "b", title: "myra" }),
      workbench({ id: "c", title: "Myra" }),
    ];
    expect(findMyraWorkbench(items)?.id).toBe("b");
  });

  test("findMyraWorkbench returns undefined when none match", () => {
    expect(
      findMyraWorkbench([workbench({ id: "a", title: "general" })]),
    ).toBeUndefined();
  });
});

function definition(partial: {
  readonly id: string;
  readonly name: string;
}): AgentDefinition {
  return {
    id: partial.id,
    tenantId: "tnt_1",
    name: partial.name,
    currentVersion: "1",
    status: "deployed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("findMyraDefinition", () => {
  test("matches the seeded assistant asset, not a display name", () => {
    const definitions = [
      definition({ id: "def-echo", name: "echo" }),
      definition({ id: "def-assistant", name: "assistant" }),
    ];
    expect(findMyraDefinition(definitions)?.id).toBe("def-assistant");
  });

  test("returns undefined when no assistant definition is deployed", () => {
    expect(
      findMyraDefinition([definition({ id: "def-echo", name: "echo" })]),
    ).toBeUndefined();
  });
});

describe("ensureMyraWorkbench", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetMyraWorkbenchCache();
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

  test("creates a chat with Myra's definitionId when no Myra row exists", async () => {
    const calls = stubFetch((path) => {
      if (path.endsWith("/chat/workbenches?kind=workbench")) {
        return json({ items: [] });
      }
      if (path.endsWith("/chat/workbenches?kind=chat")) {
        return json({ items: [] });
      }
      if (path.includes("/workflows/definitions")) {
        return json({
          data: [definition({ id: "def-assistant", name: "assistant" })],
          nextCursor: null,
        });
      }
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

    const result = await ensureMyraWorkbench("tnt_1");

    expect(result).toEqual({ kind: "ready", workbenchId: "chat-1" });
    const createCall = calls.find((call) =>
      call.path.endsWith("/chat/workbenches"),
    );
    expect(createCall?.init?.method).toBe("POST");
    expect(JSON.parse(String(createCall?.init?.body))).toEqual({
      kind: "chat",
      definitionId: "def-assistant",
      name: "Myra",
      reuseExisting: true,
    });
    expect(isMyraWorkbenchId("chat-1")).toBe(true);
  });

  test("converts a legacy workbench-kind Myra row carrying the agent into an auto-responding chat", async () => {
    const legacyWire = {
      id: "legacy-1",
      title: "Myra",
      kind: "workbench",
      pinned: true,
      participants: [{ address: "myra@wf_1.tnt_1", handle: "myra" }],
    };
    const calls = stubFetch((path) => {
      if (path.endsWith("/chat/workbenches?kind=workbench")) {
        return json({ items: [legacyWire] });
      }
      if (path.endsWith("/chat/workbenches?kind=chat")) {
        return json({ items: [] });
      }
      if (path.endsWith("/chat/workbenches/legacy-1/settings")) {
        return json({
          ...legacyWire,
          kind: "chat",
          settings: { "chat/kind": "chat" },
          contextWindow: { value: 50, source: "inherit" },
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    const result = await ensureMyraWorkbench("tnt_1");

    expect(result).toEqual({ kind: "ready", workbenchId: "legacy-1" });
    expect(isMyraWorkbenchId("legacy-1")).toBe(true);
    const patchCall = calls.find((call) => call.init?.method === "PATCH");
    expect(JSON.parse(String(patchCall?.init?.body))).toEqual({
      "chat/kind": "chat",
    });
  });

  test("errors when no Myra definition is deployed for the tenant", async () => {
    stubFetch((path) => {
      if (path.endsWith("/chat/workbenches?kind=workbench"))
        return json({ items: [] });
      if (path.endsWith("/chat/workbenches?kind=chat"))
        return json({ items: [] });
      if (path.includes("/workflows/definitions")) {
        return json({ data: [], nextCursor: null });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    const result = await ensureMyraWorkbench("tnt_1");

    expect(result.kind).toBe("error");
  });
});
