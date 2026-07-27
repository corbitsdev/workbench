import { describe, expect, it } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createLinearTools } from "./index";
import {
  asConnection,
  lastBody,
  makeFetchStub,
  makeRoutingFetchStub,
} from "./test-helpers";

describe("linear_list_issue_statuses", () => {
  it("lists team workflow states", async () => {
    const nodes = [{ id: "s1", name: "Done", type: "completed" }];
    const fetcher = makeRoutingFetchStub([
      { includes: "TeamByName", data: { teams: { nodes: [{ id: "t1" }] } } },
      {
        includes: "ListStatuses",
        data: {
          team: {
            states: {
              nodes,
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        },
      },
    ]);
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "1",
        name: "linear_list_issue_statuses",
        arguments: { team: "t1" },
      },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual(asConnection(nodes));
    const body = lastBody(fetcher, 1);
    expect(body.query).toContain("team(id: $teamId)");
    expect(body.variables).toEqual({ teamId: "t1", first: 25 });
  });
});

describe("linear_get_issue_status", () => {
  it("fetches status by workflowState id when id is set", async () => {
    const state = { id: "s1", name: "Done", type: "completed" };
    const fetcher = makeFetchStub({ data: { workflowState: state } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "1",
        name: "linear_get_issue_status",
        arguments: { team: "t1", name: "Done", id: "s1" },
      },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual(state);
    expect(lastBody(fetcher).query).toContain("workflowState(id:");
  });

  it("resolves status by team and name when id is omitted", async () => {
    const nodes = [{ id: "s1", name: "In Progress", type: "started" }];
    const fetcher = makeRoutingFetchStub([
      { includes: "TeamByName", data: { teams: { nodes: [{ id: "t1" }] } } },
      { includes: "GetStatus", data: { team: { states: { nodes } } } },
    ]);
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "1",
        name: "linear_get_issue_status",
        arguments: { team: "t1", name: "In Progress" },
      },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual(nodes[0]);
    const body = lastBody(fetcher, 1);
    expect(body.query).toContain("states(filter:");
    expect(body.variables).toEqual({ teamId: "t1", name: "In Progress" });
  });
});
