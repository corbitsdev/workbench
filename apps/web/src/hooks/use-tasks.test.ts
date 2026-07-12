/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import type { Task } from "@workbench/shared";

class TestApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let apiResponses: unknown[];
let apiRejections: unknown[];
let apiCalls: { method: string; path: string }[];
mock.module("../lib/api", () => ({
  ApiError: TestApiError,
  api: (method: string, path: string) => {
    apiCalls.push({ method, path });
    const rejection = apiRejections.shift();
    if (rejection !== undefined) return Promise.reject(rejection);
    return Promise.resolve(apiResponses.shift());
  },
}));

const {
  TASKS_QUERY_KEY,
  TASKS_PAGE_LIMIT,
  useTasks,
  useTask,
  isTaskNotFound,
} = require("./use-tasks");

function task(over: Partial<Task>): Task {
  return {
    id: "t",
    tenantId: "ten-1",
    ownerPrincipalId: "prn-1",
    createdByPrincipalId: "prn-1",
    title: "Follow up",
    status: "open",
    source: "user",
    links: [],
    externalRefs: [],
    createdAt: "2026-07-11T08:00:00.000Z",
    updatedAt: "2026-07-11T08:00:00.000Z",
    ...over,
  };
}

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

afterEach(() => {
  apiResponses = [];
  apiRejections = [];
  apiCalls = [];
});
apiResponses = [];
apiRejections = [];
apiCalls = [];

describe("tasks query constants", () => {
  it("matches the hub's default page size", () => {
    expect(TASKS_PAGE_LIMIT).toBe(50);
  });

  it("uses one shared query key", () => {
    expect(TASKS_QUERY_KEY).toEqual(["tasks"]);
  });
});

describe("useTasks", () => {
  it("fetches the first page with an explicit limit and no cursor", async () => {
    apiResponses = [{ items: [task({ id: "1" })] }];
    const { result } = renderHook(() => useTasks(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((t: Task) => t.id)).toEqual(["1"]);
    expect(apiCalls).toEqual([
      { method: "GET", path: `/me/tasks?limit=${TASKS_PAGE_LIMIT}` },
    ]);
  });

  it("flattens multiple loaded pages and reports hasNextPage", async () => {
    apiResponses = [
      { items: [task({ id: "1" }), task({ id: "2" })], nextCursor: "cursor-a" },
      { items: [task({ id: "3" })] },
    ];
    const { result } = renderHook(() => useTasks(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);

    result.current.fetchNextPage();
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));

    expect(result.current.data?.map((t: Task) => t.id)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(apiCalls).toEqual([
      { method: "GET", path: `/me/tasks?limit=${TASKS_PAGE_LIMIT}` },
      {
        method: "GET",
        path: `/me/tasks?limit=${TASKS_PAGE_LIMIT}&cursor=cursor-a`,
      },
    ]);
  });

  it("reports no next page when the server omits nextCursor", async () => {
    apiResponses = [{ items: [task({ id: "1" })] }];
    const { result } = renderHook(() => useTasks(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(false);
  });

  it("does not fetch while disabled", () => {
    apiResponses = [{ items: [] }];
    renderHook(() => useTasks({ enabled: false }), { wrapper: wrapper() });
    expect(apiCalls).toEqual([]);
  });
});

describe("useTask", () => {
  it("fetches a task by id regardless of the loaded /me/tasks pages", async () => {
    apiResponses = [task({ id: "task-old" })];
    const { result } = renderHook(() => useTask("task-old"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.id).toBe("task-old");
    expect(apiCalls).toEqual([{ method: "GET", path: "/me/tasks/task-old" }]);
  });

  it("does not fetch when id is null", () => {
    renderHook(() => useTask(null), { wrapper: wrapper() });
    expect(apiCalls).toEqual([]);
  });

  it("surfaces a 404 so the caller can tell a genuinely missing task apart from any other failure", async () => {
    apiRejections = [new TestApiError("not found", 404)];
    const { result } = renderHook(() => useTask("task-gone"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(isTaskNotFound(result.current.error)).toBe(true);
  });

  it("does not treat a non-404 failure as not-found", async () => {
    apiRejections = [new TestApiError("server error", 500)];
    const { result } = renderHook(() => useTask("task-broken"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(isTaskNotFound(result.current.error)).toBe(false);
  });
});
