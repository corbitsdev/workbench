import { describe, expect, it } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createLinearTools } from "./index";
import { asConnection, lastBody, makeFetchStub } from "./test-helpers";

describe("linear_list_views", () => {
  it("lists custom views", async () => {
    const nodes = [{ id: "v1", name: "My view", filterData: {} }];
    const fetcher = makeFetchStub({
      data: {
        customViews: {
          nodes,
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      },
    });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      { id: "1", name: "linear_list_views", arguments: { limit: 5 } },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual(asConnection(nodes));
    const body = lastBody(fetcher);
    expect(body.query).toContain("customViews(first:");
    expect(body.variables).toEqual({ first: 5 });
  });
});
