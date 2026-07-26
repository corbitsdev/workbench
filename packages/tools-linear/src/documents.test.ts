import { describe, expect, it } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createLinearTools } from "./index";
import {
  asConnection,
  lastBody,
  makeFetchStub,
  makeRoutingFetchStub,
} from "./test-helpers";

describe("linear_list_documents", () => {
  it("lists documents with optional title filter", async () => {
    const nodes = [{ id: "d1", title: "Spec", slug: "spec" }];
    const fetcher = makeFetchStub({
      data: {
        documents: { nodes, pageInfo: { endCursor: null, hasNextPage: false } },
      },
    });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      { id: "1", name: "linear_list_documents", arguments: { query: "spec" } },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.query).toContain("documents(first:");
    expect(body.variables).toEqual({
      first: 25,
      filter: { title: { containsIgnoreCase: "spec" } },
    });
  });
});

describe("linear_get_document", () => {
  it("gets document by id", async () => {
    const doc = { id: "d1", title: "T", content: "body" };
    const fetcher = makeFetchStub({ data: { document: doc } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      { id: "1", name: "linear_get_document", arguments: { id: "d1" } },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual(doc);
  });
});

describe("linear_save_document", () => {
  it("runs documentCreate when id is omitted", async () => {
    const fetcher = makeRoutingFetchStub([
      {
        includes: "documentCreate",
        data: { documentCreate: { success: true, document: { id: "d-new" } } },
      },
    ]);
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "1",
        name: "linear_save_document",
        arguments: { title: "New doc", content: "# hi", project: "p1" },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.query).toContain("documentCreate(input:");
    expect(body.variables).toEqual({
      input: { title: "New doc", content: "# hi", projectId: "p1" },
    });
  });

  it("runs documentUpdate when id is set", async () => {
    const fetcher = makeRoutingFetchStub([
      {
        includes: "documentUpdate",
        data: { documentUpdate: { success: true, document: { id: "d1" } } },
      },
    ]);
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "1",
        name: "linear_save_document",
        arguments: { id: "d1", title: "T2" },
      },
      new AbortController().signal,
    );

    expect(lastBody(fetcher).query).toContain("documentUpdate(id:");
  });
});
