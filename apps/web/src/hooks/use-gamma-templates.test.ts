/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import {
  GammaTemplateSchema,
  useGammaTemplates,
  useCreateGammaTemplate,
} from "./use-gamma-templates";
import { type } from "arktype";

const validTemplate = {
  id: "gtpl_1",
  version: 1,
  name: "Pitch Deck",
  gammaId: "abc123",
  description: "A pitch template",
  authorId: "prn_1",
  canManage: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function wrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("GammaTemplateSchema", () => {
  it("parses a well-formed template", () => {
    const parsed = GammaTemplateSchema(validTemplate);
    expect(parsed instanceof type.errors).toBe(false);
  });

  it("rejects a template missing canManage", () => {
    const { canManage, ...malformed } = validTemplate;
    void canManage;
    const parsed = GammaTemplateSchema(malformed);
    expect(parsed instanceof type.errors).toBe(true);
  });
});

describe("useGammaTemplates", () => {
  it("does not fetch while tenantId is null", () => {
    const fetchMock = mock(() => Promise.resolve(jsonResponse([])));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    renderHook(() => useGammaTemplates(null), { wrapper: wrapper() });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("parses a valid array response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonResponse([validTemplate])),
    ) as unknown as typeof fetch;
    const { result } = renderHook(() => useGammaTemplates("tenant-1"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0].gammaId).toBe("abc123");
  });

  it("throws on a malformed response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonResponse([{ id: "x", name: "bad" }])),
    ) as unknown as typeof fetch;
    const { result } = renderHook(() => useGammaTemplates("tenant-1"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toContain(
      "Unexpected gamma-templates response",
    );
  });
});

describe("useCreateGammaTemplate", () => {
  it("POSTs the template body to /gamma-templates with tenantId", async () => {
    const fetchMock = mock((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse(validTemplate, 201)),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useCreateGammaTemplate("tenant-1"), {
      wrapper: wrapper(),
    });
    await result.current.mutateAsync({
      name: "Pitch Deck",
      gammaId: "abc123",
      description: "A pitch template",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/gamma-templates?tenantId=tenant-1");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      name: "Pitch Deck",
      gammaId: "abc123",
      description: "A pitch template",
    });
  });
});
