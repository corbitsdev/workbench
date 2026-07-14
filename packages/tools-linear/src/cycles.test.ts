import { describe, expect, it } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createLinearTools } from "./index";
import {
  asConnection,
  lastBody,
  makeFetchStub,
  makeRoutingFetchStub,
} from "./test-helpers";

describe("linear_list_cycles", () => {
  it("lists cycles for a team", async () => {
    const nodes = [{ id: "cy1", name: "Cycle 1", number: 1 }];
    const fetcher = makeRoutingFetchStub([
      { includes: "GetTeam", data: { team: { id: "ENG", name: "Eng" } } },
      {
        includes: "ListCycles",
        data: { team: { cycles: { nodes, pageInfo: { endCursor: null, hasNextPage: false } } } },
      },
    ]);
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));

    const result = await runner.run(
      {
        id: "c1",
        name: "linear_list_cycles",
        arguments: { team: "ENG" },
      },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual(asConnection(nodes));
    const body = lastBody(fetcher, 1);
    expect(body.query).toContain("team(id: $teamId)");
    expect(body.query).toContain("cycles(first:");
    expect(body.variables).toEqual({ teamId: "ENG", first: 25 });
  });

  it("forwards type current as CycleFilter isActive", async () => {
    const fetcher = makeRoutingFetchStub([
      { includes: "GetTeam", data: { team: { id: "t1" } } },
      { includes: "ListCycles", data: { team: { cycles: { nodes: [] } } } },
    ]);
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));

    await runner.run(
      {
        id: "c1",
        name: "linear_list_cycles",
        arguments: { team: "t1", type: "current" },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher, 1);
    expect(body.variables).toEqual({
      teamId: "t1",
      first: 25,
      filter: { isActive: { eq: true } },
    });
  });

  it("forwards type previous as isPast", async () => {
    const fetcher = makeRoutingFetchStub([
      { includes: "GetTeam", data: { team: { id: "t1" } } },
      { includes: "ListCycles", data: { team: { cycles: { nodes: [] } } } },
    ]);
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));

    await runner.run(
      {
        id: "c1",
        name: "linear_list_cycles",
        arguments: { team: "t1", type: "previous" },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher, 1);
    expect(body.variables.filter).toEqual({ isPast: { eq: true } });
  });

  it("forwards type next as isFuture", async () => {
    const fetcher = makeRoutingFetchStub([
      { includes: "GetTeam", data: { team: { id: "t1" } } },
      { includes: "ListCycles", data: { team: { cycles: { nodes: [] } } } },
    ]);
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));

    await runner.run(
      {
        id: "c1",
        name: "linear_list_cycles",
        arguments: { team: "t1", type: "next" },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher, 1);
    expect(body.variables.filter).toEqual({ isFuture: { eq: true } });
  });

  it("errors when team is not found", async () => {
    const fetcher = makeRoutingFetchStub([
      { includes: "TeamByName", data: { teams: { nodes: [] } } },
      { includes: "GetTeam", data: { team: null } },
    ]);
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));

    const result = await runner.run(
      {
        id: "c1",
        name: "linear_list_cycles",
        arguments: { team: "nope" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Linear team not found: nope");
  });
});