import { describe, expect, mock, test } from "bun:test";

import {
  ApiQueryError,
  describeQueryError,
  toAPIQuery,
  UnauthenticatedError,
} from "./envelope";

describe("ApiQueryError", () => {
  test("carries an optional status", () => {
    const withStatus = new ApiQueryError("boom", 409);
    expect(withStatus.message).toBe("boom");
    expect(withStatus.status).toBe(409);

    const withoutStatus = new ApiQueryError("network down");
    expect(withoutStatus.status).toBeUndefined();
  });
});

describe("UnauthenticatedError", () => {
  test("defaults to a stable name and message", () => {
    const error = new UnauthenticatedError();
    expect(error.name).toBe("UnauthenticatedError");
    expect(error.message).toBe("unauthenticated");
  });
});

describe("describeQueryError", () => {
  test("maps a network failure (TypeError) to connectivity copy", () => {
    expect(describeQueryError(new TypeError("Failed to fetch"))).toBe(
      "Can't reach the server. Check your connection.",
    );
  });

  test("maps everything else to generic retry copy", () => {
    expect(describeQueryError(new Error("boom"))).toBe(
      "Something went wrong. Try again.",
    );
    expect(describeQueryError(new ApiQueryError("boom", 500))).toBe(
      "Something went wrong. Try again.",
    );
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
