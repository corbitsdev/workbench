import { describe, expect, it } from "bun:test";
import {
  connectionResult,
  paginationVariables,
  resolveListPagination,
} from "./pagination";

describe("pagination helpers", () => {
  it("resolveListPagination prefers limit over first", () => {
    expect(resolveListPagination({ limit: 10, first: 5 }, 50, 25)).toEqual({
      first: 10,
      after: null,
    });
  });

  it("resolveListPagination caps at max", () => {
    expect(resolveListPagination({ first: 999 }, 50, 25)).toEqual({
      first: 25,
      after: null,
    });
  });

  it("paginationVariables omits after when cursor is absent", () => {
    expect(paginationVariables({ first: 50, after: null })).toEqual({
      first: 50,
    });
  });

  it("paginationVariables includes after when set", () => {
    expect(paginationVariables({ first: 10, after: "abc" })).toEqual({
      first: 10,
      after: "abc",
    });
  });

  it("connectionResult normalizes nodes and pageInfo", () => {
    expect(
      connectionResult({
        nodes: [{ id: "1" }],
        pageInfo: { endCursor: "c", hasNextPage: true },
      }),
    ).toEqual({
      nodes: [{ id: "1" }],
      pageInfo: { endCursor: "c", hasNextPage: true },
    });
  });
});
