/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useArtifactDownloadText } from "./use-artifact-download-text";

const originalFetch = globalThis.fetch;

function textResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(null),
  } as unknown as Response;
}

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("useArtifactDownloadText", () => {
  it("does not fetch while disabled", () => {
    const fetchMock = mock(() => Promise.resolve(textResponse("a,b\n1,2\n")));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    renderHook(() => useArtifactDownloadText("art-1", false), {
      wrapper: wrapper(),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch when the artifact id is missing", () => {
    const fetchMock = mock(() => Promise.resolve(textResponse("a,b\n1,2\n")));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    renderHook(() => useArtifactDownloadText(undefined, true), {
      wrapper: wrapper(),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the raw text body from the download route when enabled", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(textResponse("region,total\nWest,42\n")),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(
      () => useArtifactDownloadText("art-1", true),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe("region,total\nWest,42\n");
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toMatch(/\/api\/v1\/artifacts\/art-1\/download$/);
  });

  it("surfaces an error when the download route fails", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(textResponse("boom", 500)),
    ) as unknown as typeof fetch;
    const { result } = renderHook(
      () => useArtifactDownloadText("art-1", true),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
