// Query-key helpers and the APIQuery adapter — pure unit coverage so the
// TanStack cutover does not depend only on page-level smoke.

import { describe, expect, mock, test } from "bun:test";

import { toAPIQuery } from "../src/api";
import {
  UnauthenticatedError,
  meKeys,
  pathToQueryKey,
  tenantKeys,
} from "../src/query-client";

describe("pathToQueryKey", () => {
  test("maps identity-scoped hub paths onto meKeys", () => {
    expect(pathToQueryKey("/api/me")).toEqual(meKeys.profile);
    expect(pathToQueryKey("/api/me/principals")).toEqual(meKeys.principals);
    expect(pathToQueryKey("/api/me/workflows/runs")).toEqual(meKeys.runs);
  });

  test("maps needs-you onto a tenant-scoped key", () => {
    expect(pathToQueryKey("/api/tenants/tnt_1/approvals/needs-you")).toEqual(
      tenantKeys.needsYou("tnt_1"),
    );
  });

  test("maps tenant assets onto a tenant-scoped key", () => {
    expect(pathToQueryKey("/api/tenants/tnt_1/assets")).toEqual(
      tenantKeys.assets("tnt_1"),
    );
  });

  test("falls back to a path key for unknown routes", () => {
    expect(pathToQueryKey("/api/mystery")).toEqual(["path", "/api/mystery"]);
  });
});

describe("toAPIQuery", () => {
  test("loading while fetch is in flight with no data", () => {
    expect(
      toAPIQuery({
        isLoading: true,
        isError: false,
        error: null,
        data: undefined,
        isPending: true,
        fetchStatus: "fetching",
        refetch: mock(() => undefined),
      }),
    ).toEqual({ kind: "loading" });
  });

  test("maps UnauthenticatedError to unauthenticated", () => {
    expect(
      toAPIQuery({
        isLoading: false,
        isError: true,
        error: new UnauthenticatedError(),
        data: undefined,
        isPending: false,
        fetchStatus: "idle",
        refetch: mock(() => undefined),
      }),
    ).toEqual({ kind: "unauthenticated" });
  });

  test("maps unknown errors to plain, actionable copy — never the raw message", () => {
    const result = toAPIQuery({
      isLoading: false,
      isError: true,
      error: new Error("boom"),
      data: undefined,
      isPending: false,
      fetchStatus: "idle",
      refetch: mock(() => undefined),
    });
    expect(result).toEqual({
      kind: "error",
      message: "Something went wrong. Try again.",
      retry: expect.any(Function),
    });
  });

  test("maps a network failure (TypeError) to connectivity copy", () => {
    const result = toAPIQuery({
      isLoading: false,
      isError: true,
      error: new TypeError("Failed to fetch"),
      data: undefined,
      isPending: false,
      fetchStatus: "idle",
      refetch: mock(() => undefined),
    });
    expect(result).toEqual({
      kind: "error",
      message: "Can't reach the server. Check your connection.",
      retry: expect.any(Function),
    });
  });

  test("error's retry calls the query's own refetch", () => {
    const refetch = mock(() => undefined);
    const result = toAPIQuery({
      isLoading: false,
      isError: true,
      error: new Error("boom"),
      data: undefined,
      isPending: false,
      fetchStatus: "idle",
      refetch,
    });
    if (result.kind !== "error") throw new Error("expected error kind");
    result.retry();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  test("ready when data is present", () => {
    expect(
      toAPIQuery({
        isLoading: false,
        isError: false,
        error: null,
        data: { ok: true },
        isPending: false,
        fetchStatus: "idle",
        refetch: mock(() => undefined),
      }),
    ).toEqual({ kind: "ready", data: { ok: true } });
  });

  test("disabled / idle with no data still reports loading", () => {
    expect(
      toAPIQuery({
        isLoading: false,
        isError: false,
        error: null,
        data: undefined,
        isPending: true,
        fetchStatus: "idle",
        refetch: mock(() => undefined),
      }),
    ).toEqual({ kind: "loading" });
  });
});
