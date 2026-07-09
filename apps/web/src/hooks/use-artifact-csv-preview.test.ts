/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { fetchCsvPreview } from "../lib/api";
import { useArtifactCsvPreview } from "./use-artifact-csv-preview";

const originalFetch = globalThis.fetch;

// A minimal Response stub whose headers.get is case-insensitive like the real
// Headers, so the Content-Type / Content-Length guards are exercised for real.
function response(
  body: string,
  init: {
    status?: number;
    contentType?: string | null;
    contentLength?: number;
  },
): Response {
  const headers = new Map<string, string>();
  if (init.contentType !== null && init.contentType !== undefined) {
    headers.set("content-type", init.contentType);
  }
  if (init.contentLength !== undefined) {
    headers.set("content-length", String(init.contentLength));
  }
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
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

describe("fetchCsvPreview", () => {
  it("returns a csv result when the content type is text/csv", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        response("a,b\n1,2\n", { contentType: "text/csv; charset=utf-8" }),
      ),
    ) as unknown as typeof fetch;
    const result = await fetchCsvPreview("/artifacts/x/download", 1000);
    expect(result).toEqual({ kind: "csv", text: "a,b\n1,2\n" });
  });

  it("routes a non-csv content type to the not-csv branch without parsing", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        response("<html>nope</html>", { contentType: "text/html" }),
      ),
    ) as unknown as typeof fetch;
    const result = await fetchCsvPreview("/artifacts/x/download", 1000);
    expect(result).toEqual({
      kind: "not-csv",
      text: "<html>nope</html>",
      contentType: "text/html",
    });
  });

  it("treats a missing content type as not-csv", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(response("a,b\n1,2\n", { contentType: null })),
    ) as unknown as typeof fetch;
    const result = await fetchCsvPreview("/artifacts/x/download", 1000);
    expect(result.kind).toBe("not-csv");
  });

  it("refuses a payload whose declared Content-Length exceeds the cap", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        response("small", { contentType: "text/csv", contentLength: 5000 }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await fetchCsvPreview("/artifacts/x/download", 100);
    expect(result).toEqual({ kind: "too-large", bytes: 5000 });
  });

  it("refuses a chunked payload with no length header once the body exceeds the cap", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        response("a,b\n1,2,3,4,5\n", { contentType: "text/csv" }),
      ),
    ) as unknown as typeof fetch;
    const result = await fetchCsvPreview("/artifacts/x/download", 5);
    expect(result.kind).toBe("too-large");
  });

  it("throws on a non-ok response so the caller can fall back to a download link", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(response("boom", { status: 500 })),
    ) as unknown as typeof fetch;
    await expect(
      fetchCsvPreview("/artifacts/x/download", 1000),
    ).rejects.toThrow();
  });
});

describe("useArtifactCsvPreview", () => {
  it("does not fetch while disabled", () => {
    const fetchMock = mock(() =>
      Promise.resolve(response("a,b\n1,2\n", { contentType: "text/csv" })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    renderHook(() => useArtifactCsvPreview("art-1", false), {
      wrapper: wrapper(),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch when the artifact id is missing", () => {
    const fetchMock = mock(() =>
      Promise.resolve(response("a,b\n1,2\n", { contentType: "text/csv" })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    renderHook(() => useArtifactCsvPreview(undefined, true), {
      wrapper: wrapper(),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a csv result from the download route when enabled", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        response("region,total\nWest,42\n", { contentType: "text/csv" }),
      ),
    ) as unknown as typeof fetch;
    const { result } = renderHook(() => useArtifactCsvPreview("art-1", true), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      kind: "csv",
      text: "region,total\nWest,42\n",
    });
  });
});
