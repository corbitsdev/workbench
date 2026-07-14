import { describe, expect, it } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createLinearTools } from "./index";
import { asConnection, lastBody, makeFetchStub } from "./test-helpers";

describe("linear_list_dashboards", () => {
  it("lists dashboards when the API returns data", async () => {
    const nodes = [{ id: "dash-1", name: "Velocity" }];
    const fetcher = makeFetchStub({
      data: { dashboards: { nodes, pageInfo: { endCursor: null, hasNextPage: false } } },
    });
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));

    const result = await runner.run(
      { id: "1", name: "linear_list_dashboards", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual(asConnection(nodes));
    expect(lastBody(fetcher).query).toContain("dashboards(first:");
  });

  it("returns unsupported marker when GraphQL fails", async () => {
    const fetcher = makeFetchStub({
      errors: [{ message: "Cannot query field dashboards" }],
    });
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));

    const result = await runner.run(
      { id: "1", name: "linear_list_dashboards", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(String(result.content)) as Record<string, unknown>;
    expect(parsed.unsupported).toBe(true);
    expect(String(parsed.reason)).toContain("analytics");
  });
});