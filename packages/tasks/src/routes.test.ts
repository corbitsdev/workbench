// Mounts `createTaskRoutes` into a bare `Hono` with a fake launch port
// and the in-memory store, exercising the route surface itself:
// request parsing, grant checks, and HTTP envelope mapping —
// `launcher.test.ts` covers `launchTask` itself.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { TenantEnv } from "@intx/hub-api";

import {
  TaskDefinitionNotFoundError,
  TaskDefinitionNotLaunchableError,
  TaskDefinitionNotTaskableError,
} from "./launcher";
import { createTaskRoutes, type CreateTaskRoutesDeps } from "./routes";
import { createMemoryTaskStore, type TaskRecord } from "./store";

const TENANT = { id: "tnt_1" };

function principal(id: string) {
  return { id };
}

function mountAs(app: Hono<TenantEnv>, principalId: string): Hono<TenantEnv> {
  const asPrincipal: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT as never);
    c.set("principal", principal(principalId) as never);
    await next();
  };
  const mounted = new Hono<TenantEnv>();
  mounted.use("*", asPrincipal);
  mounted.route("/", app);
  return mounted;
}

function buildDeps(
  overrides: Partial<CreateTaskRoutesDeps> = {},
): CreateTaskRoutesDeps {
  return {
    store: createMemoryTaskStore(),
    requireGrant: () => async (_c, next) => {
      await next();
    },
    launch: async (input): Promise<TaskRecord> => ({
      id: "task_1",
      tenantId: input.tenantId,
      principalId: input.principalId,
      definitionId: input.definitionId,
      agentName: "Agent",
      prompt: input.prompt,
      modelPreference: input.modelPreference ?? null,
      status: "running",
      runId: "run_1",
      resultMailId: null,
      plannerRunId: null,
      createdAt: new Date(),
      completedAt: null,
    }),
    ...overrides,
  };
}

describe("POST /", () => {
  test("launches a task and returns 201 with the created record", async () => {
    const app = mountAs(createTaskRoutes(buildDeps()), "prn_alice");

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        definitionId: "wfd_agent",
        agentName: "Agent",
        prompt: "Summarize the incident.",
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      item: { id: string; status: string };
    };
    expect(body.item.id).toBe("task_1");
    expect(body.item.status).toBe("running");
  });

  test("a malformed body is rejected with the structured error envelope", async () => {
    const app = mountAs(createTaskRoutes(buildDeps()), "prn_alice");

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "" }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  test("a denied grant is rejected before any task is launched", async () => {
    let launched = false;
    const deps = buildDeps({
      requireGrant: () => async (c) =>
        c.json({ error: { code: "forbidden", message: "no" } }, 403),
      launch: async () => {
        launched = true;
        throw new Error("should never be called");
      },
    });
    const app = mountAs(createTaskRoutes(deps), "prn_alice");

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_agent", prompt: "hi" }),
    });

    expect(response.status).toBe(403);
    expect(launched).toBe(false);
  });

  test("an unknown definition maps to 404", async () => {
    const deps = buildDeps({
      launch: async () => {
        throw new TaskDefinitionNotFoundError("wfd_missing");
      },
    });
    const app = mountAs(createTaskRoutes(deps), "prn_alice");

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_missing", prompt: "hi" }),
    });

    expect(response.status).toBe(404);
  });

  test("a non-taskable definition maps to 404", async () => {
    const deps = buildDeps({
      launch: async () => {
        throw new TaskDefinitionNotTaskableError("wfd_automation");
      },
    });
    const app = mountAs(createTaskRoutes(deps), "prn_alice");

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_automation", prompt: "hi" }),
    });

    expect(response.status).toBe(404);
  });

  test("an unlaunchable definition maps to 400", async () => {
    const deps = buildDeps({
      launch: async () => {
        throw new TaskDefinitionNotLaunchableError("wfd_agent", "not deployed");
      },
    });
    const app = mountAs(createTaskRoutes(deps), "prn_alice");

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_agent", prompt: "hi" }),
    });

    expect(response.status).toBe(400);
  });
});

describe("GET / and GET /:id", () => {
  test("tasks are personal: a same-workbench colleague's task reads as absent", async () => {
    // Deliberate scope tightening past the tenant-wide grant: a
    // prompt is private to whoever wrote it, so another principal in
    // the SAME tenant sees neither the row in the list nor the detail
    // (404, not 403 — the response must not leak that it exists).
    const store = createMemoryTaskStore();
    await store.createTask({
      id: "task_1",
      tenantId: TENANT.id,
      principalId: "prn_alice",
      definitionId: "wfd_agent",
      agentName: "Agent",
      prompt: "Summarize the incident.",
      modelPreference: null,
      runId: "run_1",
    });

    const asBob = mountAs(createTaskRoutes(buildDeps({ store })), "prn_bob");

    const list = await asBob.request("/");
    const listBody = (await list.json()) as { items: { id: string }[] };
    expect(listBody.items).toEqual([]);

    const detail = await asBob.request("/task_1");
    expect(detail.status).toBe(404);

    const asAlice = mountAs(
      createTaskRoutes(buildDeps({ store })),
      "prn_alice",
    );
    expect((await asAlice.request("/task_1")).status).toBe(200);
  });

  test("lists and fetches a tenant's own tasks only", async () => {
    const store = createMemoryTaskStore();
    await store.createTask({
      id: "task_1",
      tenantId: TENANT.id,
      principalId: "prn_alice",
      definitionId: "wfd_agent",
      agentName: "Agent",
      prompt: "hi",
      modelPreference: null,
      runId: "run_1",
    });
    await store.createTask({
      id: "task_2",
      tenantId: "tnt_other",
      principalId: "prn_bob",
      definitionId: "wfd_agent",
      agentName: "Agent",
      prompt: "hi",
      modelPreference: null,
      runId: "run_2",
    });

    const app = mountAs(createTaskRoutes(buildDeps({ store })), "prn_alice");

    const list = await app.request("/");
    const listBody = (await list.json()) as { items: { id: string }[] };
    expect(listBody.items.map((item) => item.id)).toEqual(["task_1"]);

    const found = await app.request("/task_1");
    expect(found.status).toBe(200);

    const missing = await app.request("/task_2");
    expect(missing.status).toBe(404);
  });
});
