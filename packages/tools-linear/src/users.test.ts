import { describe, expect, it } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createLinearTools } from "./index";
import { asConnection, lastBody, makeFetchStub } from "./test-helpers";

describe("linear_list_users", () => {
  it("lists users with custom first", async () => {
    const nodes = [{ id: "u1", name: "Ada", email: "ada@x.com", active: true }];
    const fetcher = makeFetchStub({ data: { users: { nodes } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "c1",
        name: "linear_list_users",
        arguments: { first: 10 },
      },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual(asConnection(nodes));
    const body = lastBody(fetcher);
    expect(body.query).toContain("users(first:");
    expect(body.variables).toEqual({ first: 10 });
  });

  it("forwards query and team as UserFilter", async () => {
    const fetcher = makeFetchStub({ data: { users: { nodes: [] } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "c1",
        name: "linear_list_users",
        arguments: { query: "ada", team: "team-uuid" },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.variables).toEqual({
      first: 25,
      filter: {
        name: { containsIgnoreCase: "ada" },
        team: { id: { eq: "team-uuid" } },
      },
    });
  });
});

describe("linear_get_user", () => {
  it("fetches a user by id", async () => {
    const user = { id: "u1", name: "Ada", email: "ada@x.com", active: true };
    const fetcher = makeFetchStub({ data: { user } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      { id: "c1", name: "linear_get_user", arguments: { id: "u1" } },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual(user);
    const body = lastBody(fetcher);
    expect(body.query).toContain("user(id: $id)");
    expect(body.variables).toEqual({ id: "u1" });
  });

  it("errors when user is missing", async () => {
    const fetcher = makeFetchStub({ data: { user: null } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      { id: "c1", name: "linear_get_user", arguments: { id: "missing" } },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Linear user not found: missing");
  });
});
