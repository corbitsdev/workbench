import { describe, expect, it } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createLinearTools } from "./index";
import {
  asConnection,
  lastBody,
  makeFetchStub,
  makeRoutingFetchStub,
} from "./test-helpers";

describe("linear_list_comments", () => {
  it("lists comments on an issue with pagination variables", async () => {
    const nodes = [{ id: "c1", body: "hi", user: { name: "Ada" } }];
    const fetcher = makeFetchStub({
      data: {
        issue: {
          comments: {
            nodes,
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      },
    });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "1",
        name: "linear_list_comments",
        arguments: { issueId: "iss-1", first: 5 },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual(asConnection(nodes));
    const body = lastBody(fetcher);
    expect(body.query).toContain("comments(first:");
    expect(body.variables).toEqual({ issueId: "iss-1", first: 5 });
  });

  it("errors when the issue is missing", async () => {
    const fetcher = makeFetchStub({ data: { issue: null } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "1",
        name: "linear_list_comments",
        arguments: { issueId: "missing" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Linear issue not found: missing");
  });
});

describe("linear_save_comment", () => {
  it("runs commentCreate when id is omitted", async () => {
    const fetcher = makeRoutingFetchStub([
      {
        includes: "commentCreate",
        data: {
          commentCreate: { success: true, comment: { id: "c-new", body: "x" } },
        },
      },
    ]);
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "1",
        name: "linear_save_comment",
        arguments: { issueId: "iss-1", body: "hello" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual({
      success: true,
      comment: { id: "c-new", body: "x" },
    });
    const body = lastBody(fetcher);
    expect(body.query).toContain("commentCreate(input:");
    expect(body.variables).toEqual({
      input: { issueId: "iss-1", body: "hello" },
    });
  });

  it("runs commentUpdate when id is provided", async () => {
    const fetcher = makeRoutingFetchStub([
      {
        includes: "commentUpdate",
        data: {
          commentUpdate: {
            success: true,
            comment: { id: "c-1", body: "edited" },
          },
        },
      },
    ]);
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "1",
        name: "linear_save_comment",
        arguments: { id: "c-1", issueId: "iss-1", body: "edited" },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.query).toContain("commentUpdate(id:");
    expect(body.variables).toEqual({
      id: "c-1",
      input: { body: "edited" },
    });
  });
});
