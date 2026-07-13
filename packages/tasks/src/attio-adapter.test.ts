import { describe, expect, it, mock } from "bun:test";
import type { RequestInit } from "undici-types";
import type { Task } from "@workbench/shared";
import type { AttioFetch } from "@workbench/tools-attio";

import type { TaskPushInput } from "./adapter";
import { createAttioTaskAdapter } from "./attio-adapter";
import { TASK_ADAPTERS } from "./registry";
import { TaskAdapterDescriptorSchema } from "./adapter";
import { type } from "arktype";

const credential = { apiKey: "test-key", baseURL: "" };

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    tenantId: "tenant-1",
    ownerPrincipalId: "principal-owner",
    createdByPrincipalId: "principal-owner",
    title: "Follow up with Acme",
    body: "Send the pricing deck",
    status: "open",
    source: "user",
    links: [{ kind: "url", ref: "attio:companies:rec_123", label: "Acme" }],
    externalRefs: [],
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

function makeInput(overrides: Partial<TaskPushInput> = {}): TaskPushInput {
  return {
    task: makeTask(),
    externalRef: null,
    idempotencyKey: "task:task-1:create",
    actorPrincipalId: "principal-actor",
    assignee: null,
    ...overrides,
  };
}

type Route = {
  match: (url: string, init: RequestInit) => boolean;
  body: unknown;
  status?: number;
};

function makeRouterStub(routes: Route[]) {
  return mock((input: string, init: RequestInit) => {
    const route = routes.find((r) => r.match(input, init));
    if (route === undefined) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as unknown as AttioFetch & { mock: { calls: [string, RequestInit][] } };
}

describe("TASK_ADAPTERS registry", () => {
  it("contains attio as the v1 entry with a valid self-describing descriptor", () => {
    const attio = TASK_ADAPTERS["attio"];
    expect(attio).toBeDefined();
    const descriptor = TaskAdapterDescriptorSchema({
      id: attio?.id,
      label: attio?.label,
      providerName: attio?.providerName,
      operations: attio?.operations,
      externalRef: attio?.externalRef,
    });
    expect(descriptor).not.toBeInstanceOf(type.errors);
    expect(attio?.id).toBe("attio");
    expect(attio?.providerName).toBe("attio");
    expect(attio?.operations).toEqual(["create", "update", "close", "comment"]);
  });
});

describe("createAttioTaskAdapter create", () => {
  it("writes an idempotency-marked note on the linked Attio record and returns the note id", async () => {
    const fetcher = makeRouterStub([
      {
        match: (url, init) =>
          url.includes("/v2/notes?") && init.method === "GET",
        body: { data: [] },
      },
      {
        match: (url, init) =>
          url.endsWith("/v2/notes") && init.method === "POST",
        body: { data: { id: { note_id: "note_1" } } },
      },
    ]);
    const adapter = createAttioTaskAdapter({ fetcher });

    const result = await adapter.execute("create", makeInput(), credential);

    expect(result).toEqual({ externalId: "note_1", deduped: false });
    const post = fetcher.mock.calls.find(([, init]) => init.method === "POST");
    expect(post).toBeDefined();
    const body = JSON.parse(String(post?.[1].body)) as {
      data: {
        parent_object: string;
        parent_record_id: string;
        content: string;
        title: string;
      };
    };
    expect(body.data.parent_object).toBe("companies");
    expect(body.data.parent_record_id).toBe("rec_123");
    expect(body.data.title).toBe("Follow up with Acme");
    expect(body.data.content).toContain("Send the pricing deck");
    expect(body.data.content).toContain("<!-- idem:task:task-1:create -->");
    expect(body.data.content).toContain("principal-actor");
  });

  it("returns deduped when a note already carries the idempotency marker", async () => {
    const fetcher = makeRouterStub([
      {
        match: (url, init) =>
          url.includes("/v2/notes?") && init.method === "GET",
        body: {
          data: [
            {
              id: { note_id: "note_existing" },
              content_markdown: "Follow up\n\n<!-- idem:task:task-1:create -->",
            },
          ],
        },
      },
    ]);
    const adapter = createAttioTaskAdapter({ fetcher });

    const result = await adapter.execute("create", makeInput(), credential);

    expect(result).toEqual({ externalId: "note_existing", deduped: true });
    expect(
      fetcher.mock.calls.filter(([, init]) => init.method === "POST"),
    ).toHaveLength(0);
  });

  it("fails loudly when the task carries no Attio record link", async () => {
    const fetcher = makeRouterStub([]);
    const adapter = createAttioTaskAdapter({ fetcher });
    const input = makeInput({ task: makeTask({ links: [] }) });

    await expect(adapter.execute("create", input, credential)).rejects.toThrow(
      /no attio record link/i,
    );
    expect(fetcher.mock.calls).toHaveLength(0);
  });

  it("propagates a non-2xx Attio response as a thrown error", async () => {
    const fetcher = makeRouterStub([
      {
        match: (url, init) =>
          url.includes("/v2/notes?") && init.method === "GET",
        body: { data: [] },
      },
      {
        match: (url, init) =>
          url.endsWith("/v2/notes") && init.method === "POST",
        body: { error: "boom" },
        status: 500,
      },
    ]);
    const adapter = createAttioTaskAdapter({ fetcher });

    await expect(
      adapter.execute("create", makeInput(), credential),
    ).rejects.toThrow(/Attio API error: 500/);
  });
});

describe("createAttioTaskAdapter close", () => {
  it("PATCHes the linked Attio task to completed", async () => {
    const fetcher = makeRouterStub([
      {
        match: (url, init) =>
          url.includes("/v2/tasks/ext_task_1") && init.method === "PATCH",
        body: { data: { id: { task_id: "ext_task_1" } } },
      },
    ]);
    const adapter = createAttioTaskAdapter({ fetcher });
    const input = makeInput({
      task: makeTask({ status: "done" }),
      externalRef: {
        adapterId: "attio",
        externalId: "ext_task_1",
        syncState: "synced",
      },
      idempotencyKey: "task:task-1:close",
    });

    const result = await adapter.execute("close", input, credential);

    expect(result).toEqual({ externalId: "ext_task_1", deduped: false });
    const patch = fetcher.mock.calls[0];
    const body = JSON.parse(String(patch?.[1].body)) as {
      data: { is_completed: boolean };
    };
    expect(body.data.is_completed).toBe(true);
  });

  it("fails loudly when closing without an external ref", async () => {
    const fetcher = makeRouterStub([]);
    const adapter = createAttioTaskAdapter({ fetcher });

    await expect(
      adapter.execute("close", makeInput(), credential),
    ).rejects.toThrow(/no external/i);
  });
});

describe("createAttioTaskAdapter update", () => {
  it("pushes a due-date change onto the external Attio task", async () => {
    const fetcher = makeRouterStub([
      {
        match: (url, init) =>
          url.includes("/v2/tasks/ext_task_1") && init.method === "PATCH",
        body: { data: { id: { task_id: "ext_task_1" } } },
      },
    ]);
    const adapter = createAttioTaskAdapter({ fetcher });
    const input = makeInput({
      task: makeTask({ due: "2026-08-01T00:00:00.000Z" }),
      externalRef: {
        adapterId: "attio",
        externalId: "ext_task_1",
        syncState: "synced",
      },
      idempotencyKey: "task:task-1:update",
    });

    const result = await adapter.execute("update", input, credential);

    expect(result).toEqual({ externalId: "ext_task_1", deduped: false });
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1].body)) as {
      data: { deadline_at: string };
    };
    expect(body.data.deadline_at).toBe("2026-08-01T00:00:00.000Z");
  });
});

describe("createAttioTaskAdapter comment", () => {
  it("writes a comment note with the comment idempotency key", async () => {
    const fetcher = makeRouterStub([
      {
        match: (url, init) =>
          url.includes("/v2/notes?") && init.method === "GET",
        body: { data: [] },
      },
      {
        match: (url, init) =>
          url.endsWith("/v2/notes") && init.method === "POST",
        body: { data: { id: { note_id: "note_2" } } },
      },
    ]);
    const adapter = createAttioTaskAdapter({ fetcher });
    const input = makeInput({ idempotencyKey: "task:task-1:comment" });

    const result = await adapter.execute("comment", input, credential);

    expect(result).toEqual({ externalId: "note_2", deduped: false });
    const post = fetcher.mock.calls.find(([, init]) => init.method === "POST");
    const body = JSON.parse(String(post?.[1].body)) as {
      data: { content: string };
    };
    expect(body.data.content).toContain("<!-- idem:task:task-1:comment -->");
  });
});
