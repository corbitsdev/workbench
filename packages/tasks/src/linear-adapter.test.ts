import { describe, expect, it, mock } from "bun:test";
import type { RequestInit } from "undici-types";
import type { Task } from "@workbench/shared";
import type { LinearFetch } from "@workbench/tools-linear";
import { type } from "arktype";

import type { TaskPushInput } from "./adapter";
import { TaskAdapterDescriptorSchema } from "./adapter";
import { createLinearTaskAdapter } from "./linear-adapter";
import { TASK_ADAPTERS } from "./registry";

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
    links: [{ kind: "url", ref: "linear:team:team_123", label: "Engineering" }],
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
  match: (query: string, variables: Record<string, unknown>) => boolean;
  body: unknown;
  status?: number;
};

function makeRouterStub(routes: Route[]) {
  return mock((_input: string, init: RequestInit) => {
    const parsed = JSON.parse(String(init.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const route = routes.find((r) => r.match(parsed.query, parsed.variables));
    if (route === undefined) {
      return Promise.resolve(
        new Response(JSON.stringify({ errors: [{ message: "no route" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as unknown as LinearFetch & {
    mock: { calls: [string, RequestInit][] };
  };
}

describe("TASK_ADAPTERS registry", () => {
  it("contains linear as an entry with a valid self-describing descriptor", () => {
    const linear = TASK_ADAPTERS["linear"];
    expect(linear).toBeDefined();
    const descriptor = TaskAdapterDescriptorSchema({
      id: linear?.id,
      label: linear?.label,
      providerName: linear?.providerName,
      operations: linear?.operations,
      externalRef: linear?.externalRef,
    });
    expect(descriptor).not.toBeInstanceOf(type.errors);
    expect(linear?.id).toBe("linear");
    expect(linear?.providerName).toBe("linear");
    expect(linear?.operations).toEqual(["create", "update", "close", "comment"]);
  });
});

describe("createLinearTaskAdapter create", () => {
  it("creates a Linear issue on the linked team and returns the issue id and url", async () => {
    const fetcher = makeRouterStub([
      {
        match: (query) => query.includes("issueCreate"),
        body: {
          data: {
            issueCreate: {
              success: true,
              issue: { id: "issue_1", identifier: "ENG-1", url: "https://linear.app/x/issue/ENG-1" },
            },
          },
        },
      },
    ]);
    const adapter = createLinearTaskAdapter({ fetcher });

    const result = await adapter.execute("create", makeInput(), credential);

    expect(result).toEqual({
      externalId: "issue_1",
      externalUrl: "https://linear.app/x/issue/ENG-1",
      deduped: false,
    });
    const call = fetcher.mock.calls[0];
    const body = JSON.parse(String(call?.[1].body)) as {
      variables: { input: { teamId: string; title: string; description: string } };
    };
    expect(body.variables.input.teamId).toBe("team_123");
    expect(body.variables.input.title).toBe("Follow up with Acme");
    expect(body.variables.input.description).toContain("Send the pricing deck");
    expect(body.variables.input.description).toContain(
      "<!-- idem:task:task-1:create -->",
    );
  });

  it("fails loudly when the task carries no linear team link", async () => {
    const fetcher = makeRouterStub([]);
    const adapter = createLinearTaskAdapter({ fetcher });
    const input = makeInput({ task: makeTask({ links: [] }) });

    await expect(adapter.execute("create", input, credential)).rejects.toThrow(
      /no linear team link/i,
    );
    expect(fetcher.mock.calls).toHaveLength(0);
  });

  it("fails loudly when the task carries conflicting linear team links", async () => {
    const fetcher = makeRouterStub([]);
    const adapter = createLinearTaskAdapter({ fetcher });
    const input = makeInput({
      task: makeTask({
        links: [
          { kind: "url", ref: "linear:team:team_123", label: "Engineering" },
          { kind: "url", ref: "linear:team:team_456", label: "Design" },
        ],
      }),
    });

    await expect(adapter.execute("create", input, credential)).rejects.toThrow(
      /ambiguous/i,
    );
    expect(fetcher.mock.calls).toHaveLength(0);
  });

  it("propagates a non-2xx Linear response as a thrown error", async () => {
    const fetcher = makeRouterStub([
      {
        match: (query) => query.includes("issueCreate"),
        body: { error: "boom" },
        status: 500,
      },
    ]);
    const adapter = createLinearTaskAdapter({ fetcher });

    await expect(
      adapter.execute("create", makeInput(), credential),
    ).rejects.toThrow(/Linear API error: 500/);
  });
});

describe("createLinearTaskAdapter close", () => {
  it("resolves the completed workflow state and patches the linked issue", async () => {
    const fetcher = makeRouterStub([
      {
        match: (query) => query.includes("TeamStates"),
        body: {
          data: {
            team: {
              states: {
                nodes: [
                  { id: "state_started", name: "In Progress", type: "started" },
                  { id: "state_done", name: "Done", type: "completed" },
                ],
              },
            },
          },
        },
      },
      {
        match: (query) => query.includes("issueUpdate"),
        body: {
          data: {
            issueUpdate: {
              success: true,
              issue: { id: "issue_1", identifier: "ENG-1", url: "https://linear.app/x/issue/ENG-1" },
            },
          },
        },
      },
    ]);
    const adapter = createLinearTaskAdapter({ fetcher });
    const input = makeInput({
      task: makeTask({ status: "done" }),
      externalRef: { adapterId: "linear", externalId: "issue_1", syncState: "synced" },
      idempotencyKey: "task:task-1:close",
    });

    const result = await adapter.execute("close", input, credential);

    expect(result).toEqual({
      externalId: "issue_1",
      externalUrl: "https://linear.app/x/issue/ENG-1",
      deduped: false,
    });
    const updateCall = fetcher.mock.calls.find(([, init]) =>
      String(init.body).includes("issueUpdate"),
    );
    const body = JSON.parse(String(updateCall?.[1].body)) as {
      variables: { id: string; input: { stateId: string } };
    };
    expect(body.variables.id).toBe("issue_1");
    expect(body.variables.input.stateId).toBe("state_done");
  });

  it("fails loudly when the team has no workflow state of the target type", async () => {
    const fetcher = makeRouterStub([
      {
        match: (query) => query.includes("TeamStates"),
        body: {
          data: {
            team: {
              states: {
                nodes: [
                  { id: "state_started", name: "In Progress", type: "started" },
                ],
              },
            },
          },
        },
      },
      {
        match: (query) => query.includes("issueUpdate"),
        body: {
          data: {
            issueUpdate: {
              success: true,
              issue: { id: "issue_1", identifier: "ENG-1", url: "https://linear.app/x/issue/ENG-1" },
            },
          },
        },
      },
    ]);
    const adapter = createLinearTaskAdapter({ fetcher });
    const input = makeInput({
      task: makeTask({ status: "done" }),
      externalRef: { adapterId: "linear", externalId: "issue_1", syncState: "synced" },
      idempotencyKey: "task:task-1:close",
    });

    await expect(adapter.execute("close", input, credential)).rejects.toThrow(
      /no workflow state of type "completed"/i,
    );
    const updateCall = fetcher.mock.calls.find(([, init]) =>
      String(init.body).includes("issueUpdate"),
    );
    expect(updateCall).toBeUndefined();
  });

  it("fails loudly when closing without an external ref", async () => {
    const fetcher = makeRouterStub([]);
    const adapter = createLinearTaskAdapter({ fetcher });

    await expect(
      adapter.execute("close", makeInput(), credential),
    ).rejects.toThrow(/no external/i);
  });
});

describe("createLinearTaskAdapter update", () => {
  it("resolves the started workflow state for an in_progress task", async () => {
    const fetcher = makeRouterStub([
      {
        match: (query) => query.includes("TeamStates"),
        body: {
          data: {
            team: {
              states: {
                nodes: [
                  { id: "state_started", name: "In Progress", type: "started" },
                ],
              },
            },
          },
        },
      },
      {
        match: (query) => query.includes("issueUpdate"),
        body: {
          data: {
            issueUpdate: {
              success: true,
              issue: { id: "issue_1", identifier: "ENG-1", url: "https://linear.app/x/issue/ENG-1" },
            },
          },
        },
      },
    ]);
    const adapter = createLinearTaskAdapter({ fetcher });
    const input = makeInput({
      task: makeTask({ status: "in_progress" }),
      externalRef: { adapterId: "linear", externalId: "issue_1", syncState: "synced" },
      idempotencyKey: "task:task-1:update",
    });

    const result = await adapter.execute("update", input, credential);

    expect(result.externalId).toBe("issue_1");
    const updateCall = fetcher.mock.calls.find(([, init]) =>
      String(init.body).includes("issueUpdate"),
    );
    const body = JSON.parse(String(updateCall?.[1].body)) as {
      variables: { input: { stateId: string; title: string } };
    };
    expect(body.variables.input.stateId).toBe("state_started");
    expect(body.variables.input.title).toBe("Follow up with Acme");
  });
});

describe("createLinearTaskAdapter comment", () => {
  it("creates a comment on the linked issue with the comment idempotency key", async () => {
    const fetcher = makeRouterStub([
      {
        match: (query) => query.includes("commentCreate"),
        body: { data: { commentCreate: { success: true, comment: { id: "comment_1" } } } },
      },
    ]);
    const adapter = createLinearTaskAdapter({ fetcher });
    const input = makeInput({
      externalRef: {
        adapterId: "linear",
        externalId: "issue_1",
        externalUrl: "https://linear.app/x/issue/ENG-1",
        syncState: "synced",
      },
      idempotencyKey: "task:task-1:comment",
    });

    const result = await adapter.execute("comment", input, credential);

    expect(result).toEqual({
      externalId: "issue_1",
      externalUrl: "https://linear.app/x/issue/ENG-1",
      deduped: false,
    });
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1].body)) as {
      variables: { input: { issueId: string; body: string } };
    };
    expect(body.variables.input.issueId).toBe("issue_1");
    expect(body.variables.input.body).toContain(
      "<!-- idem:task:task-1:comment -->",
    );
  });

  it("fails loudly when commenting without an external ref", async () => {
    const fetcher = makeRouterStub([]);
    const adapter = createLinearTaskAdapter({ fetcher });

    await expect(
      adapter.execute("comment", makeInput(), credential),
    ).rejects.toThrow(/no external/i);
  });
});
