import { expect, test } from "bun:test";

import { createTask, listTaskMessages, manusRequest } from "./client";

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
