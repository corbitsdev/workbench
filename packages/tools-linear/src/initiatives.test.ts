import { describe, expect, it } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createLinearTools } from "./index";
import { asConnection, lastBody, makeFetchStub } from "./test-helpers";

describe("linear_list_initiatives", () => {
  it("lists initiatives with default first", async () => {
    const nodes = [{ id: "i1", name: "Platform", status: "Active" }];
    const fetcher = makeFetchStub({ data: { initiatives: { nodes } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      { id: "c1", name: "linear_list_initiatives", arguments: {} },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual(asConnection(nodes));
    const body = lastBody(fetcher);
    expect(body.query).toContain("initiatives(first:");
    expect(body.variables).toEqual({ first: 25 });
  });

  it("forwards query as InitiativeFilter", async () => {
    const fetcher = makeFetchStub({ data: { initiatives: { nodes: [] } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "c1",
        name: "linear_list_initiatives",
        arguments: { query: "growth" },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.variables).toEqual({
      first: 25,
      filter: { name: { containsIgnoreCase: "growth" } },
    });
  });
});

describe("linear_save_initiative", () => {
  it("runs initiativeCreate when id is omitted", async () => {
    const fetcher = makeFetchStub({
      data: {
        initiativeCreate: {
          success: true,
          initiative: { id: "i-new", name: "Q3" },
        },
      },
    });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "c1",
        name: "linear_save_initiative",
        arguments: { name: "Q3", status: "Planned", description: "d" },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.query).toContain("initiativeCreate(input: $input)");
    expect(body.variables).toEqual({
      input: { name: "Q3", status: "Planned", description: "d" },
    });
  });

  it("runs initiativeUpdate when id is provided", async () => {
    const fetcher = makeFetchStub({
      data: {
        initiativeUpdate: {
          success: true,
          initiative: { id: "i1", name: "Q3+" },
        },
      },
    });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "c1",
        name: "linear_save_initiative",
        arguments: { id: "i1", name: "Q3+" },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.query).toContain("initiativeUpdate(id: $id");
    expect(body.variables).toEqual({
      id: "i1",
      input: { name: "Q3+" },
    });
  });
});
