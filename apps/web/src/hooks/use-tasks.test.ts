/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import type { Task } from "@workbench/shared";

let apiResponses: unknown[];
let apiCalls: { method: string; path: string }[];
mock.module("../lib/api", () => ({
  api: (method: string, path: string) => {
    apiCalls.push({ method, path });
    return Promise.resolve(apiResponses.shift());
  },
}));

const { TASKS_QUERY_KEY, TASKS_PAGE_LIMIT, useTasks } = require("./use-tasks");

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
  apiCalls = [];
});
apiResponses = [];
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
