import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import {
  createWorkbench,
  NEW_WORKBENCH_TITLE,
  WorkbenchPostCreateError,
  WorkbenchPreconditionError,
} from "./instant-agent-create";

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

describe("createWorkbench", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  type RecordedCall = { readonly path: string; readonly init?: RequestInit };

  function stubFetch(respond: (path: string) => Response): RecordedCall[] {
    const calls: RecordedCall[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === "string" ? input : new URL(String(input)).pathname;
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

  test("mints two distinct workbenches on two calls, never reusing one", async () => {
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
          kind: "workbench",
          pinned: false,
          participants: [],
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    await createWorkbench("tnt_1", (to) => navigated.push(to), newQueryClient());
    await createWorkbench("tnt_1", (to) => navigated.push(to), newQueryClient());

    const createCalls = calls.filter((call) => call.path.endsWith("/chat/workbenches"));
    expect(createCalls).toHaveLength(2);
    expect(navigated).toEqual(["/w/chan-1", "/w/chan-2"]);
    expect(navigated[0]).not.toBe(navigated[1]);
    const body = JSON.parse(String(createCalls[0]?.init?.body));
    expect(body.name).toBe(NEW_WORKBENCH_TITLE);
    expect(body.kind).toBe("workbench");
    expect(body.definitionId).toBeUndefined();
  });

  test("fails with WorkbenchPreconditionError when Myra isn't deployed yet", async () => {
    stubFetch((path) => {
      if (path.includes("/workflows/definitions")) {
        return json({ data: [], nextCursor: null });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    let cause: unknown;
    try {
      await createWorkbench("tnt_1", () => undefined, newQueryClient());
    } catch (error) {
      cause = error;
    }
    expect(cause).toBeInstanceOf(WorkbenchPreconditionError);
    expect((cause as WorkbenchPreconditionError).kind).toBe("setup-agent-missing");
  });

  test("a first message renames the room off New Workbench via chat/name", async () => {
    const navigated: string[] = [];
    const calls = stubFetch((path) => {
      if (path.includes("/workflows/definitions")) {
        return json({ data: [assistantDefinitionWire], nextCursor: null });
      }
      if (path.endsWith("/chat/workbenches")) {
        return json({
          id: "chan-adhoc",
          title: NEW_WORKBENCH_TITLE,
          kind: "workbench",
          pinned: false,
          participants: [],
        });
      }
      if (path.endsWith("/chat/workbenches/chan-adhoc/messages")) {
        return json({
          id: "msg-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          sender: { name: "Sawyer", address: "principal-1" },
          parts: [{ kind: "text", text: "Plan the Q3 launch" }],
        });
      }
      if (path.endsWith("/chat/workbenches/chan-adhoc/settings")) {
        return json({
          id: "chan-adhoc",
          title: "Plan the Q3 launch",
          kind: "workbench",
          pinned: false,
          participants: [],
          settings: { "chat/name": "Plan the Q3 launch" },
          contextWindow: { value: 0, source: "inherit" },
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    await createWorkbench(
      "tnt_1",
      (to) => navigated.push(to),
      newQueryClient(),
      "Plan the Q3 launch",
    );

    const settingsCall = calls.find((call) =>
      call.path.endsWith("/chat/workbenches/chan-adhoc/settings"),
    );
    expect(JSON.parse(String(settingsCall?.init?.body))).toEqual({
      "chat/name": "Plan the Q3 launch",
    });
    expect(navigated).toEqual(["/w/chan-adhoc"]);
  });

  test("an opening-message failure leaves a minted workbench recoverable", async () => {
    stubFetch((path) => {
      if (path.includes("/workflows/definitions")) {
        return json({ data: [assistantDefinitionWire], nextCursor: null });
      }
      if (path.endsWith("/chat/workbenches")) {
        return json({
          id: "chan-recoverable",
          title: NEW_WORKBENCH_TITLE,
          kind: "workbench",
          pinned: false,
          participants: [],
        });
      }
      if (path.endsWith("/chat/workbenches/chan-recoverable/invite")) {
        return json({ address: "def-assistant@tnt-1.corbits.dev", definitionId: "def-assistant" });
      }
      // the opening message now posts through `@corbits/mailbox`'s
      // `POST /me/inbox/send` rather than the chat route.
      if (path.endsWith("/mailbox/me/inbox/send")) {
        return json({ error: "agent launch failed" }, 409);
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    let cause: unknown;
    try {
      await createWorkbench(
        "tnt_1",
        () => undefined,
        newQueryClient(),
        "Research our next partner",
        ["def-assistant"],
      );
    } catch (error) {
      cause = error;
    }

    expect(cause).toBeInstanceOf(WorkbenchPostCreateError);
    if (!(cause instanceof WorkbenchPostCreateError)) {
      throw new Error("expected a recoverable post-create error");
    }
    expect(cause.workbenchId).toBe("chan-recoverable");
    expect(cause.stage).toBe("opening-message");
  });
});
