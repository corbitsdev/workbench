import { describe, expect, it, mock } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createLinearTools } from "./index";
import {
  asConnection,
  lastBody,
  makeFetchStub,
  makeRoutingFetchStub,
} from "./test-helpers";

const TEAM_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

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

describe("linear_get_team / resolveTeamId", () => {
  it("resolves UUID-shaped input via GetTeam without TeamByName", async () => {
    const team = { id: TEAM_UUID, name: "Engineering", key: "ENG" };
    const fetcher = makeRoutingFetchStub([
      { includes: "GetTeam", data: { team } },
    ]);
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));

    const result = await runner.run(
      { id: "c1", name: "linear_get_team", arguments: { id: TEAM_UUID } },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual(team);
    // resolveTeamId GetTeam + getTeam GetTeam — never TeamByName
    expect(fetcher.mock.calls).toHaveLength(2);
    for (const call of fetcher.mock.calls) {
      const body = JSON.parse(String(call[1].body)) as { query: string };
      expect(body.query).toContain("GetTeam");
      expect(body.query).not.toContain("TeamByName");
    }
  });

  it("resolves non-UUID name via TeamByName only (no GetTeam probe)", async () => {
    const team = { id: TEAM_UUID, name: "Engineering", key: "ENG" };
    const fetcher = makeRoutingFetchStub([
      {
        includes: "TeamByName",
        data: { teams: { nodes: [{ id: TEAM_UUID }] } },
      },
      { includes: "GetTeam", data: { team } },
    ]);
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));

    const result = await runner.run(
      { id: "c1", name: "linear_get_team", arguments: { id: "Engineering" } },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual(team);
    expect(fetcher.mock.calls).toHaveLength(2);
    const resolveBody = lastBody(fetcher, 0);
    expect(resolveBody.query).toContain("TeamByName");
    expect(resolveBody.query).not.toContain("GetTeam");
    expect(resolveBody.variables).toEqual({ name: "Engineering" });
    const getBody = lastBody(fetcher, 1);
    expect(getBody.query).toContain("GetTeam");
    expect(getBody.variables).toEqual({ id: TEAM_UUID });
  });

  it("falls back from UUID GetTeam miss to name search", async () => {
    const team = {
      id: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
      name: TEAM_UUID,
      key: "X",
    };
    const seen: string[] = [];
    let getTeamCount = 0;
    const sequential = mock((_input: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string };
      if (body.query.includes("TeamByName")) {
        seen.push("TeamByName");
        return Promise.resolve(
          new Response(
            JSON.stringify({ data: { teams: { nodes: [{ id: team.id }] } } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (body.query.includes("GetTeam")) {
        getTeamCount += 1;
        seen.push("GetTeam");
        // First GetTeam (resolve): miss; second (getTeam): hit
        const payload =
          getTeamCount === 1 ? { team: null } : { team };
        return Promise.resolve(
          new Response(JSON.stringify({ data: payload }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ errors: [{ message: "unstubbed" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher: sequential }),
    );

    const result = await runner.run(
      { id: "c1", name: "linear_get_team", arguments: { id: TEAM_UUID } },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual(team);
    expect(seen).toEqual(["GetTeam", "TeamByName", "GetTeam"]);
  });

  it("errors when name is not found without probing GetTeam", async () => {
    const fetcher = makeRoutingFetchStub([
      { includes: "TeamByName", data: { teams: { nodes: [] } } },
    ]);
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));

    const result = await runner.run(
      { id: "c1", name: "linear_get_team", arguments: { id: "missing" } },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Linear team not found: missing");
    expect(fetcher.mock.calls).toHaveLength(1);
    expect(lastBody(fetcher).query).toContain("TeamByName");
  });
});
