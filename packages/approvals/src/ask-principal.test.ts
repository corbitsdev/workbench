// Behavioral tests for createAskPrincipalTool.
//
// We mock the @intx/agent boundary so that `tool()` returns the raw
// { definition, handler } object. This lets us drive the handler directly
// and assert on its real behavior: the create request, the poll loop, the
// returned verdict strings, and the failure modes.
//
// The hub is exercised through a stubbed global.fetch — these are the actual
// HTTP requests the tool makes, so the assertions lock in observable behavior.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("@intx/agent", () => ({
  // The real `tool()` wraps the definition + handler into an AgentTool. For
  // tests we only need the handler and definition back so we can invoke them.
  tool: (spec: unknown) => spec,
}));

const { createAskPrincipalTool } = await import("./ask-principal");

type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
};

type RawTool = {
  definition: {
    name: string;
    inputSchema: { required: string[]; properties: Record<string, unknown> };
  };
  handler: (
    call: { id: string; arguments: Record<string, unknown> },
    signal: AbortSignal,
  ) => Promise<{ callId: string; content: string; isError?: boolean }>;
};

const BASE_OPTS = {
  hubHttpUrl: "https://hub.example.com",
  sidecarToken: "sidecar-token",
  tenantId: "tenant-1",
  agentId: "agent-1",
  principalId: "principal-1",
  pollIntervalMs: 1,
};

const CALL = {
  id: "call-1",
  arguments: { action: "send the email", resource: "email://send" },
};

let calls: FetchCall[];
const originalFetch = globalThis.fetch;

function makeResponse(status: number, payload: unknown): Response {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    json: async () => payload,
    text: async () =>
      typeof payload === "string" ? payload : JSON.stringify(payload),
  } as unknown as Response;
}

/**
 * Install a fetch stub. `responder` receives the sequential call index and the
 * recorded call, and returns the Response to hand back.
 */
function stubFetch(
  responder: (index: number, call: FetchCall) => Response,
): void {
  let index = 0;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const recorded: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(recorded);
    return responder(index++, recorded);
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function getTool(overrides: Partial<typeof BASE_OPTS> = {}): RawTool {
  return createAskPrincipalTool({
    ...BASE_OPTS,
    ...overrides,
  }) as unknown as RawTool;
}

describe("tool definition", () => {
  test("exposes the ask_principal tool with action and resource required", () => {
    const t = getTool();
    expect(t.definition.name).toBe("ask_principal");
    expect(t.definition.inputSchema.required).toEqual(["action", "resource"]);
    expect(Object.keys(t.definition.inputSchema.properties)).toContain(
      "context",
    );
  });
});

describe("create request", () => {
  test("POSTs the approval to the internal endpoint with auth and full payload", async () => {
    stubFetch((i) =>
      i === 0
        ? makeResponse(201, { id: "appr-1", status: "pending", message: null })
        : makeResponse(200, {
            id: "appr-1",
            status: "approved",
            message: null,
          }),
    );

    const t = getTool();
    await t.handler(
      {
        id: "call-1",
        arguments: { action: "do x", resource: "r://x", context: { k: "v" } },
      },
      new AbortController().signal,
    );

    const create = calls[0]!;
    expect(create.method).toBe("POST");
    expect(create.url).toBe("https://hub.example.com/api/internal/approvals");
    expect(create.headers.Authorization).toBe("Bearer sidecar-token");
    expect(create.headers["Content-Type"]).toBe("application/json");
    expect(create.body).toEqual({
      tenantId: "tenant-1",
      agentId: "agent-1",
      principalId: "principal-1",
      action: "do x",
      resource: "r://x",
      context: { k: "v" },
    });
  });

  test("sends context as null when omitted", async () => {
    stubFetch((i) =>
      i === 0
        ? makeResponse(201, { id: "a", status: "pending", message: null })
        : makeResponse(200, { id: "a", status: "approved", message: null }),
    );
    const t = getTool();
    await t.handler(CALL, new AbortController().signal);
    expect((calls[0]!.body as { context: unknown }).context).toBeNull();
  });

  test("strips a trailing slash from hubHttpUrl", async () => {
    stubFetch((i) =>
      i === 0
        ? makeResponse(201, { id: "a", status: "pending", message: null })
        : makeResponse(200, { id: "a", status: "approved", message: null }),
    );
    const t = getTool({ hubHttpUrl: "https://hub.example.com/" });
    await t.handler(CALL, new AbortController().signal);
    expect(calls[0]!.url).toBe(
      "https://hub.example.com/api/internal/approvals",
    );
  });

  test("returns an error result (not a throw) when create fails", async () => {
    stubFetch(() => makeResponse(500, "boom"));
    const t = getTool();
    const result = await t.handler(CALL, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("500");
    expect(result.callId).toBe("call-1");
    // No poll should happen if create failed.
    expect(calls).toHaveLength(1);
  });
});

describe("decision polling", () => {
  test("returns Approved with the message when the principal approves", async () => {
    stubFetch((i) =>
      i === 0
        ? makeResponse(201, { id: "appr-1", status: "pending", message: null })
        : makeResponse(200, {
            id: "appr-1",
            status: "approved",
            message: "go ahead",
          }),
    );
    const t = getTool();
    const result = await t.handler(CALL, new AbortController().signal);
    expect(result.isError).toBeUndefined();
    expect(result.content).toMatch(/^Approved\b/);
    expect(result.content).toContain("go ahead");
    expect(result.callId).toBe("call-1");
  });

  test("returns an Approved verdict with no trailing message when none is given", async () => {
    stubFetch((i) =>
      i === 0
        ? makeResponse(201, { id: "appr-1", status: "pending", message: null })
        : makeResponse(200, {
            id: "appr-1",
            status: "approved",
            message: null,
          }),
    );
    const t = getTool();
    const result = await t.handler(CALL, new AbortController().signal);
    expect(result.content).toMatch(/^Approved\b/);
  });

  test("returns Rejected with the message when the principal rejects", async () => {
    stubFetch((i) =>
      i === 0
        ? makeResponse(201, { id: "appr-1", status: "pending", message: null })
        : makeResponse(200, {
            id: "appr-1",
            status: "rejected",
            message: "not allowed",
          }),
    );
    const t = getTool();
    const result = await t.handler(CALL, new AbortController().signal);
    expect(result.isError).toBeUndefined();
    expect(result.content).toMatch(/^Rejected\b/);
    expect(result.content).toContain("not allowed");
  });

  test("polls the record by id with the tenantId query param", async () => {
    stubFetch((i) =>
      i === 0
        ? makeResponse(201, { id: "appr-99", status: "pending", message: null })
        : makeResponse(200, {
            id: "appr-99",
            status: "approved",
            message: null,
          }),
    );
    const t = getTool();
    await t.handler(CALL, new AbortController().signal);
    const poll = calls[1]!;
    expect(poll.method).toBe("GET");
    expect(poll.url).toBe(
      "https://hub.example.com/api/internal/approvals/appr-99?tenantId=tenant-1",
    );
    expect(poll.headers.Authorization).toBe("Bearer sidecar-token");
  });

  test("keeps polling while pending and resolves once status changes", async () => {
    stubFetch((i) => {
      if (i === 0)
        return makeResponse(201, { id: "a", status: "pending", message: null });
      if (i < 3)
        return makeResponse(200, { id: "a", status: "pending", message: null });
      return makeResponse(200, { id: "a", status: "approved", message: null });
    });
    const t = getTool();
    const result = await t.handler(CALL, new AbortController().signal);
    expect(result.content).toMatch(/^Approved\b/);
    // create + 3 polls (two pending, one approved).
    expect(calls).toHaveLength(4);
  });
});

describe("poll failure modes", () => {
  test("aborts immediately on a 404 (record gone)", async () => {
    stubFetch((i) =>
      i === 0
        ? makeResponse(201, { id: "a", status: "pending", message: null })
        : makeResponse(404, "not found"),
    );
    const t = getTool();
    const result = await t.handler(CALL, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("permanently");
    expect(result.content).toContain("404");
    expect(calls).toHaveLength(2);
  });

  test("aborts immediately on a 401 (auth failure)", async () => {
    stubFetch((i) =>
      i === 0
        ? makeResponse(201, { id: "a", status: "pending", message: null })
        : makeResponse(401, "unauthorized"),
    );
    const t = getTool();
    const result = await t.handler(CALL, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("permanently");
    expect(calls).toHaveLength(2);
  });

  test("treats a 5xx poll error as transient and keeps polling", async () => {
    stubFetch((i) => {
      if (i === 0)
        return makeResponse(201, { id: "a", status: "pending", message: null });
      if (i === 1) return makeResponse(503, "unavailable");
      return makeResponse(200, { id: "a", status: "approved", message: null });
    });
    const t = getTool();
    const result = await t.handler(CALL, new AbortController().signal);
    expect(result.content).toMatch(/^Approved\b/);
    expect(calls).toHaveLength(3);
  });

  test("treats a network error as transient and keeps polling", async () => {
    let index = 0;
    globalThis.fetch = (async () => {
      const i = index++;
      if (i === 0)
        return makeResponse(201, { id: "a", status: "pending", message: null });
      if (i === 1) throw new Error("network down");
      return makeResponse(200, { id: "a", status: "approved", message: null });
    }) as unknown as typeof fetch;
    const t = getTool();
    const result = await t.handler(CALL, new AbortController().signal);
    expect(result.content).toMatch(/^Approved\b/);
  });
});

describe("cancellation", () => {
  test("returns a cancelled error result when the signal aborts during the poll wait", async () => {
    stubFetch((i) =>
      i === 0
        ? makeResponse(201, { id: "a", status: "pending", message: null })
        : makeResponse(200, { id: "a", status: "pending", message: null }),
    );
    const controller = new AbortController();
    const t = getTool({ pollIntervalMs: 10_000 });
    const promise = t.handler(CALL, controller.signal);
    // Let the create POST settle so the handler is parked inside the poll-wait
    // with its abort listener attached, then abort to exercise that listener.
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content).toBe("Approval request cancelled.");
    // Create happened; the abort short-circuits before any poll fetch.
    expect(calls).toHaveLength(1);
  });

  test("does not poll if the signal is already aborted before the wait completes", async () => {
    stubFetch((i) =>
      makeResponse(i === 0 ? 201 : 200, {
        id: "a",
        status: "pending",
        message: null,
      }),
    );
    const controller = new AbortController();
    controller.abort();
    const t = getTool({ pollIntervalMs: 10_000 });
    const result = await t.handler(CALL, controller.signal);
    expect(result.content).toBe("Approval request cancelled.");
    expect(calls).toHaveLength(1);
  });
});
