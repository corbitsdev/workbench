import { describe, expect, it } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createLinearTools } from "./index";
import { asConnection, lastBody, makeFetchStub } from "./test-helpers";

describe("linear_list_integrations", () => {
  it("lists integrations", async () => {
    const nodes = [{ id: "i1", service: "github", type: "import" }];
    const fetcher = makeFetchStub({
      data: {
        integrations: {
          nodes,
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      },
    });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );
    const result = await runner.run(
      { id: "1", name: "linear_list_integrations", arguments: {} },
      new AbortController().signal,
    );
    expect(JSON.parse(String(result.content))).toEqual(asConnection(nodes));
    expect(lastBody(fetcher).query).toContain("integrations");
  });
});
