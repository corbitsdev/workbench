/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  useCreateSchedule,
  useDeleteSchedule,
  useUpdateSchedule,
} from "./use-schedules";

const originalFetch = globalThis.fetch;
const SCHEDULES_KEY = ["me-schedules"] as const;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const scheduleOn = {
  id: "sch_1",
  workflowKind: "morning-brief",
  hourUtc: 13,
  enabled: true,
  triggerPayload: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  lastFiredDayUtc: null,
  nextFireAt: "2026-01-02T13:00:00.000Z",
};

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("useUpdateSchedule", () => {
  it("applies the toggle optimistically and rolls back when the request fails", async () => {
    const client = makeClient();
    client.setQueryData(SCHEDULES_KEY, [scheduleOn]);

    let resolveFetch: (r: Response) => void = () => {};
    globalThis.fetch = mock(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useUpdateSchedule(), {
      wrapper: wrapper(client),
    });

    result.current.mutate({ id: "sch_1", enabled: false });

    // Optimistic: the cache flips before the in-flight request resolves.
    await waitFor(() => {
      const rows = client.getQueryData<(typeof scheduleOn)[]>(SCHEDULES_KEY);
      expect(rows?.[0]?.enabled).toBe(false);
    });

    resolveFetch(jsonResponse({ error: "boom" }, 500));

    await waitFor(() => expect(result.current.isError).toBe(true));

    // No active list observer, so onSettled's invalidate cannot mask the
    // rollback — the cache must be restored to its pre-mutation value.
    const rolledBack =
      client.getQueryData<(typeof scheduleOn)[]>(SCHEDULES_KEY);
    expect(rolledBack?.[0]?.enabled).toBe(true);
  });
});

describe("useDeleteSchedule", () => {
  it("removes the row optimistically", async () => {
    const client = makeClient();
    client.setQueryData(SCHEDULES_KEY, [scheduleOn]);

    let resolveFetch: (r: Response) => void = () => {};
    globalThis.fetch = mock(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useDeleteSchedule(), {
      wrapper: wrapper(client),
    });

    result.current.mutate({ id: "sch_1" });

    await waitFor(() => {
      const rows = client.getQueryData<(typeof scheduleOn)[]>(SCHEDULES_KEY);
      expect(rows).toHaveLength(0);
    });

    resolveFetch(jsonResponse(null, 204));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});

describe("useCreateSchedule", () => {
  it("posts the create body to the schedules endpoint", async () => {
    const client = makeClient();
    let captured: { url: string; body: unknown } = { url: "", body: null };
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      captured = { url, body: JSON.parse((init?.body as string) ?? "null") };
      return Promise.resolve(jsonResponse(scheduleOn, 201));
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useCreateSchedule(), {
      wrapper: wrapper(client),
    });

    result.current.mutate({ kind: "morning-brief", hourUtc: 13 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(captured.url).toContain("/me/schedules");
    expect(captured.body).toEqual({ kind: "morning-brief", hourUtc: 13 });
  });
});
