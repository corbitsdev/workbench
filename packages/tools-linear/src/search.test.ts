import { describe, expect, it } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createLinearTools } from "./index";
import { asConnection, lastBody, makeFetchStub } from "./test-helpers";

describe("linear_search", () => {
  it("searches issues by term with pagination", async () => {
    const nodes = [{ id: "i1", identifier: "ENG-1", title: "auth" }];
    const fetcher = makeFetchStub({
      data: {
        searchIssues: {
          nodes,
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      },
    });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "1",
        name: "linear_search",
        arguments: { query: "auth bug", first: 10 },
      },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual(asConnection(nodes));
    const body = lastBody(fetcher);
    expect(body.query).toContain("searchIssues(term:");
    expect(body.variables).toEqual({ term: "auth bug", first: 10 });
  });
});
