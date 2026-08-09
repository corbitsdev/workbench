// Query-key helpers and the APIQuery adapter — pure unit coverage so the
// TanStack cutover does not depend only on page-level smoke.

import { describe, expect, test } from "bun:test";

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
      }),
    ).toEqual({ kind: "unauthenticated" });
  });

  test("maps other errors to error messages", () => {
    expect(
      toAPIQuery({
        isLoading: false,
        isError: true,
        error: new Error("boom"),
        data: undefined,
        isPending: false,
        fetchStatus: "idle",
      }),
    ).toEqual({ kind: "error", message: "boom" });
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
      }),
    ).toEqual({ kind: "loading" });
  });
});
