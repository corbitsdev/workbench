import { describe, expect, it } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createLinearTools } from "./index";
import { asConnection, lastBody, makeFetchStub } from "./test-helpers";

describe("linear_list_releases", () => {
  it("lists releases with default pagination", async () => {
    const nodes = [{ id: "r1", name: "v1.0", version: "1.0.0" }];
    const fetcher = makeFetchStub({ data: { releases: { nodes } } });
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));

    const result = await runner.run(
      { id: "c1", name: "linear_list_releases", arguments: {} },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual(asConnection(nodes));
    const body = lastBody(fetcher);
    expect(body.query).toContain("releases(first:");
    expect(body.variables).toEqual({ first: 25 });
  });

  it("forwards query and pipeline as ReleaseFilter", async () => {
    const fetcher = makeFetchStub({ data: { releases: { nodes: [] } } });
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));

    await runner.run(
      {
        id: "c1",
        name: "linear_list_releases",
        arguments: { query: "1.2", pipeline: "pipe-uuid" },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.variables).toEqual({
      first: 25,
      filter: {
        name: { containsIgnoreCase: "1.2" },
        pipeline: { id: { eq: "pipe-uuid" } },
      },
    });
  });
});

describe("linear_save_release", () => {
  it("runs releaseCreate when id is omitted", async () => {
    const fetcher = makeFetchStub({
      data: {
        releaseCreate: {
          success: true,
          release: { id: "r-new", name: "Launch", version: "2.0" },
        },
      },
    });
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));

    await runner.run(
      {
        id: "c1",
        name: "linear_save_release",
        arguments: {
          name: "Launch",
          pipeline: "pipe-1",
          version: "2.0",
          description: "notes",
        },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.query).toContain("releaseCreate(input: $input)");
    expect(body.variables).toEqual({
      input: {
        name: "Launch",
        pipelineId: "pipe-1",
        version: "2.0",
        description: "notes",
      },
    });
  });

  it("runs releaseUpdate when id is provided", async () => {
    const fetcher = makeFetchStub({
      data: {
        releaseUpdate: {
          success: true,
          release: { id: "r1", name: "Launch+", version: "2.0.1" },
        },
      },
    });
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));

    await runner.run(
      {
        id: "c1",
        name: "linear_save_release",
        arguments: { id: "r1", name: "Launch+", pipeline: "pipe-1" },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.query).toContain("releaseUpdate(id: $id");
    expect(body.variables).toEqual({
      id: "r1",
      input: { name: "Launch+", pipelineId: "pipe-1" },
    });
  });
});