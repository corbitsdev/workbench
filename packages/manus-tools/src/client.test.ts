import { expect, test } from "bun:test";

import {
  createSlideDeck,
  createTask,
  DEFAULT_SLIDE_MAX_POLLS,
  DEFAULT_SLIDE_POLL_INTERVAL_MS,
  latestAgentStatus,
  listTaskMessages,
  manusRequest,
  SLIDES_FORMAT_PPTX,
} from "./client";

test("createTask posts to /v2/task.create and parses the ok envelope", async () => {
  const captured: { url: string; headers: Headers | null; body: string } = {
    url: "",
    headers: null,
    body: "",
  };
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    captured.url = String(input);
    captured.headers =
      init?.headers instanceof Headers
        ? init.headers
        : new Headers(init?.headers);
    captured.body = typeof init?.body === "string" ? init.body : "";
    return new Response(
      JSON.stringify({
        ok: true,
        request_id: "req_1",
        task_id: "task_1",
        task_title: "Deck",
        task_url: "https://manus.im/app/task_1",
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const created = await createTask({ fetchImpl }, { content: "Make slides" });
  expect(captured.url).toBe("https://api.manus.ai/v2/task.create");
  expect(captured.headers?.get("x-manus-api-key")).toBeNull();
  expect(captured.headers?.get("authorization")).toBeNull();
  expect(captured.headers?.get("x-api-key")).toBeNull();
  expect(JSON.parse(captured.body)).toEqual({
    message: { content: "Make slides" },
  });
  expect(created.task_id).toBe("task_1");
  expect(created.task_url).toBe("https://manus.im/app/task_1");
});

test("listTaskMessages GETs /v2/task.listMessages without an auth header", async () => {
  const captured: { url: string; headers: Headers | null } = {
    url: "",
    headers: null,
  };
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    captured.url = String(input);
    captured.headers =
      init?.headers instanceof Headers
        ? init.headers
        : init?.headers !== undefined
          ? new Headers(init.headers)
          : null;
    return new Response(
      JSON.stringify({
        ok: true,
        task_id: "task_1",
        messages: [
          {
            type: "status_update",
            status_update: { agent_status: "stopped" },
          },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const listed = await listTaskMessages({ fetchImpl }, { task_id: "task_1" });
  expect(captured.url).toBe(
    "https://api.manus.ai/v2/task.listMessages?task_id=task_1",
  );
  expect(captured.headers?.get("x-manus-api-key") ?? null).toBeNull();
  expect(listed.messages?.[0]?.status_update?.agent_status).toBe("stopped");
});

test("maps a non-ok HTTP body with a Manus error envelope", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        ok: false,
        error: { code: "permission_denied", message: "bad key" },
      }),
      { status: 401 },
    )) as unknown as typeof fetch;

  await expect(
    manusRequest({ fetchImpl }, { method: "GET", path: "/v2/skill.list" }),
  ).rejects.toThrow(/permission_denied: bad key/);
});

test("throws when a 200 body is not an ok envelope", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ notes: [] }), {
      status: 200,
    })) as unknown as typeof fetch;

  await expect(
    manusRequest({ fetchImpl }, { method: "GET", path: "/v2/skill.list" }),
  ).rejects.toThrow(/did not match the expected shape/);
});

test("latestAgentStatus uses the first status_update under default desc order", () => {
  expect(
    latestAgentStatus([
      { type: "status_update", status_update: { agent_status: "stopped" } },
      { type: "status_update", status_update: { agent_status: "running" } },
    ]),
  ).toBe("stopped");
});

test("createSlideDeck treats mixed [stopped, running] desc as terminal", async () => {
  const listUrls: string[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v2/task.create")) {
      expect(
        JSON.parse(typeof init?.body === "string" ? init.body : ""),
      ).toEqual({
        message: {
          content:
            "Create a slide presentation in pptx format. Produce a presentation deck, not a document. Topic and requirements:\n\nOnboarding",
        },
      });
      return new Response(JSON.stringify({ ok: true, task_id: "task_1" }), {
        status: 200,
      });
    }
    if (url.includes("/v2/task.listMessages")) {
      listUrls.push(url);
      return new Response(
        JSON.stringify({
          ok: true,
          task_id: "task_1",
          messages: [
            {
              type: "status_update",
              status_update: { agent_status: "stopped" },
            },
            {
              type: "status_update",
              status_update: { agent_status: "running" },
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;

  const result = await createSlideDeck(
    { fetchImpl },
    { content: "Onboarding", pollIntervalMs: 0, maxPolls: 3 },
  );
  expect(result.agent_status).toBe("stopped");
  expect(listUrls).toHaveLength(1);
  expect(listUrls[0]).toContain(`slides_format=${SLIDES_FORMAT_PPTX}`);
  expect(listUrls[0]).not.toContain("slides_format=pdf");
  expect(SLIDES_FORMAT_PPTX).toBe("pptx");
});

test("createSlideDeck throws when the agent is still running after the poll budget", async () => {
  const fetchImpl = (async (input: URL | string) => {
    const url = String(input);
    if (url.includes("/v2/task.create")) {
      return new Response(JSON.stringify({ ok: true, task_id: "task_1" }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({
        ok: true,
        task_id: "task_1",
        messages: [
          {
            type: "status_update",
            status_update: { agent_status: "running" },
          },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  await expect(
    createSlideDeck(
      { fetchImpl },
      { content: "Onboarding", pollIntervalMs: 0, maxPolls: 2 },
    ),
  ).rejects.toThrow(/did not stop in time \(agent_status: running\)/);
});

test("createSlideDeck throws when the agent is waiting", async () => {
  const fetchImpl = (async (input: URL | string) => {
    const url = String(input);
    if (url.includes("/v2/task.create")) {
      return new Response(JSON.stringify({ ok: true, task_id: "task_1" }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({
        ok: true,
        task_id: "task_1",
        messages: [
          {
            type: "status_update",
            status_update: { agent_status: "waiting" },
          },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  await expect(
    createSlideDeck(
      { fetchImpl },
      { content: "Onboarding", pollIntervalMs: 0, maxPolls: 5 },
    ),
  ).rejects.toThrow(/waiting for confirmation/);
});

test("createSlideDeck aborts polling instead of waiting out the timeout", async () => {
  const controller = new AbortController();
  const fetchImpl = (async (input: URL | string) => {
    const url = String(input);
    if (url.includes("/v2/task.create")) {
      return new Response(JSON.stringify({ ok: true, task_id: "task_1" }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({
        ok: true,
        task_id: "task_1",
        messages: [
          {
            type: "status_update",
            status_update: { agent_status: "running" },
          },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const pending = createSlideDeck(
    { fetchImpl },
    {
      content: "Onboarding",
      pollIntervalMs: 30_000,
      maxPolls: 10,
      signal: controller.signal,
    },
  );
  queueMicrotask(() => controller.abort());
  await expect(pending).rejects.toThrow(/cancelled/);
});

test("default slide-deck wait is several minutes", () => {
  expect(
    DEFAULT_SLIDE_MAX_POLLS * DEFAULT_SLIDE_POLL_INTERVAL_MS,
  ).toBeGreaterThan(60_000);
  expect(DEFAULT_SLIDE_MAX_POLLS * DEFAULT_SLIDE_POLL_INTERVAL_MS).toBe(
    5 * 60 * 1000,
  );
});
