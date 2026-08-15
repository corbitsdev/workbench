import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import { ApiQueryError, UnauthenticatedError } from "@corbits/api-query";

import { pathToQueryKey, shouldRetryQuery, tenantKeys } from "./query-client";

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
