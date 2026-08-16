import { describe, expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import { ApiQueryError, UnauthenticatedError } from "@corbits/api-query";

import {
  createAppQueryClient,
  isAuthInvalidError,
  pathToQueryKey,
  shouldRetryQuery,
  tenantKeys,
} from "./query-client";

const TENANT = "tenant_1";

describe("shouldRetryQuery", () => {
  test("never retries once unauthenticated", () => {
    expect(shouldRetryQuery(0, new UnauthenticatedError())).toBe(false);
  });

  test("never retries a definitive 404", () => {
    expect(shouldRetryQuery(0, new ApiQueryError("not found", 404))).toBe(
      false,
    );
  });

  test("retries other statuses up to 3 attempts", () => {
    const error = new ApiQueryError("server exploded", 500);
    expect(shouldRetryQuery(0, error)).toBe(true);
    expect(shouldRetryQuery(2, error)).toBe(true);
    expect(shouldRetryQuery(3, error)).toBe(false);
  });

  test("retries a network failure with no status up to 3 attempts", () => {
    const error = new ApiQueryError("network down");
    expect(shouldRetryQuery(0, error)).toBe(true);
    expect(shouldRetryQuery(3, error)).toBe(false);
  });
});

describe("isAuthInvalidError", () => {
  test("an UnauthenticatedError is auth-invalid", () => {
    expect(isAuthInvalidError(new UnauthenticatedError())).toBe(true);
  });

  test("an ApiQueryError with status 401 is auth-invalid", () => {
    expect(isAuthInvalidError(new ApiQueryError("nope", 401))).toBe(true);
  });

  test("an ApiQueryError with a different status is not", () => {
    expect(isAuthInvalidError(new ApiQueryError("nope", 403))).toBe(false);
    expect(isAuthInvalidError(new ApiQueryError("boom", 500))).toBe(false);
  });

  test("a plain error is not", () => {
    expect(isAuthInvalidError(new Error("boom"))).toBe(false);
  });
});

// CL-6105: a hub restarted on an empty DB mid-session (or a cookie for a
// deleted user, or a session that simply expired) shows up as a 401 on
// whatever query or mutation happens to run next — never a dedicated
// "session ended" event. Every consumer of this client must be routed
// through the same `onAuthInvalid` callback, not left to render its own
// local "sign in required" box while the rest of the shell renders on.
describe("createAppQueryClient's auth-invalid wiring", () => {
  test("a query throwing UnauthenticatedError calls onAuthInvalid", async () => {
    const onAuthInvalid = mock(() => undefined);
    const client = createAppQueryClient(onAuthInvalid);
    await client
      .fetchQuery({
        queryKey: ["probe"],
        queryFn: () => {
          throw new UnauthenticatedError();
        },
        retry: false,
      })
      .catch(() => undefined);
    expect(onAuthInvalid).toHaveBeenCalledTimes(1);
  });

  test("a query throwing a 401 ApiQueryError calls onAuthInvalid", async () => {
    const onAuthInvalid = mock(() => undefined);
    const client = createAppQueryClient(onAuthInvalid);
    await client
      .fetchQuery({
        queryKey: ["probe-401"],
        queryFn: () => {
          throw new ApiQueryError("nope", 401);
        },
        retry: false,
      })
      .catch(() => undefined);
    expect(onAuthInvalid).toHaveBeenCalledTimes(1);
  });

  test("a query failing for an unrelated reason never calls onAuthInvalid", async () => {
    const onAuthInvalid = mock(() => undefined);
    const client = createAppQueryClient(onAuthInvalid);
    await client
      .fetchQuery({
        queryKey: ["probe-500"],
        queryFn: () => {
          throw new ApiQueryError("server exploded", 500);
        },
        retry: false,
      })
      .catch(() => undefined);
    expect(onAuthInvalid).not.toHaveBeenCalled();
  });

  test("a mutation that 401s also calls onAuthInvalid", async () => {
    const onAuthInvalid = mock(() => undefined);
    const client = createAppQueryClient(onAuthInvalid);
    const mutation = client.getMutationCache().build(client, {
      mutationFn: () => {
        throw new UnauthenticatedError();
      },
    });
    await mutation.execute(undefined).catch(() => undefined);
    expect(onAuthInvalid).toHaveBeenCalledTimes(1);
  });

  test("defaults to a no-op when no callback is given", async () => {
    const client = createAppQueryClient();
    await expect(
      client.fetchQuery({
        queryKey: ["probe-default"],
        queryFn: () => {
          throw new UnauthenticatedError();
        },
        retry: false,
      }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe("pathToQueryKey", () => {
  test("maps the artifacts list under the artifacts key family", () => {
    expect(pathToQueryKey(`/api/tenants/${TENANT}/artifacts`)).toEqual([
      ...tenantKeys.artifacts(TENANT),
      "",
    ]);
  });

  test("maps artifacts/counts under the artifacts key family, not the path fallback", () => {
    expect(pathToQueryKey(`/api/tenants/${TENANT}/artifacts/counts`)).toEqual(
      tenantKeys.artifactCounts(TENANT),
    );
  });
});

describe("invalidating tenantKeys.artifacts after an upload", () => {
  test("also invalidates the counts query, not just the list", async () => {
    const queryClient = new QueryClient();
    const listKey = pathToQueryKey(`/api/tenants/${TENANT}/artifacts`);
    const countsKey = pathToQueryKey(`/api/tenants/${TENANT}/artifacts/counts`);

    queryClient.setQueryData(listKey, { data: [], nextCursor: null });
    queryClient.setQueryData(countsKey, {
      all: 0,
      document: 0,
      sheet: 0,
      pdf: 0,
      routine: 0,
    });

    await queryClient.invalidateQueries({
      queryKey: tenantKeys.artifacts(TENANT),
    });

    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(countsKey)?.isInvalidated).toBe(true);
  });
});
