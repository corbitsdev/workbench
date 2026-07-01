/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMembers } from "./use-members";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return React.createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      jsonResponse({
        members: [
          { id: "prn_a", name: "Ada" },
          { id: "prn_b", name: "Grace" },
        ],
      }),
    ),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("useMembers", () => {
  it("parses the members response into { id, name } rows", async () => {
    const { result } = renderHook(() => useMembers("tenant-1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      { id: "prn_a", name: "Ada" },
      { id: "prn_b", name: "Grace" },
    ]);
  });

  it("does not fetch when disabled", () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof mock>;
    renderHook(() => useMembers("tenant-1", { enabled: false }), { wrapper });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws on a malformed response instead of returning junk", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonResponse({ members: [{ id: 123 }] })),
    ) as unknown as typeof fetch;
    const { result } = renderHook(() => useMembers("tenant-1"), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(Error);
  });
});
