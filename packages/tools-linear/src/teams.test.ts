import { describe, expect, it } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createLinearTools } from "./index";
import { asConnection, lastBody, makeFetchStub } from "./test-helpers";

describe("linear_list_teams", () => {
  it("lists teams with default first", async () => {
    const nodes = [{ id: "t1", name: "Engineering", key: "ENG" }];
    const fetcher = makeFetchStub({ data: { teams: { nodes } } });
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));

    const result = await runner.run(
      { id: "c1", name: "linear_list_teams", arguments: {} },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual(asConnection(nodes));
    const body = lastBody(fetcher);
    expect(body.query).toContain("teams(first:");
    expect(body.variables).toEqual({ first: 25 });
  });

  it("forwards query as TeamFilter", async () => {
    const fetcher = makeFetchStub({ data: { teams: { nodes: [] } } });
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));

    await runner.run(
      {
        id: "c1",
        name: "linear_list_teams",
        arguments: { query: "eng" },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.variables).toEqual({
      first: 25,
      filter: { name: { containsIgnoreCase: "eng" } },
    });
  });
});

describe("linear_get_team", () => {
  it("fetches a team by id", async () => {
    const team = { id: "t1", name: "Engineering", key: "ENG" };
    const fetcher = makeFetchStub({ data: { team } });
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));

    const result = await runner.run(
      { id: "c1", name: "linear_get_team", arguments: { id: "ENG" } },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual(team);
    const body = lastBody(fetcher);
    expect(body.query).toContain("team(id: $id)");
    expect(body.variables).toEqual({ id: "ENG" });
  });

  it("errors when team is missing", async () => {
    const fetcher = makeFetchStub({ data: { team: null } });
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));

    const result = await runner.run(
      { id: "c1", name: "linear_get_team", arguments: { id: "missing" } },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Linear team not found: missing");
  });
});