/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";

let apiResponses: unknown[];
let apiCalls: { method: string; path: string }[];
mock.module("../lib/api", () => ({
  api: (method: string, path: string) => {
    apiCalls.push({ method, path });
    return Promise.resolve(apiResponses.shift());
  },
  uploadForm: () => Promise.resolve(undefined),
}));

const { useSkillLibrary } = require("./use-skills");

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

describe("useSkillLibrary tenant gating", () => {
  it("does not fetch when tenantId is null", () => {
    renderHook(() => useSkillLibrary(null), { wrapper: wrapper() });
    expect(apiCalls).toEqual([]);
  });

  it("does not fetch when tenantId is undefined", () => {
    renderHook(() => useSkillLibrary(undefined), { wrapper: wrapper() });
    expect(apiCalls).toEqual([]);
  });

  it("fetches once tenantId resolves to a real value", async () => {
    apiResponses = [{ skills: [] }];
    const { result } = renderHook(() => useSkillLibrary("tnt_1"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiCalls).toEqual([
      { method: "GET", path: "/skills?tenantId=tnt_1" },
    ]);
  });
});
