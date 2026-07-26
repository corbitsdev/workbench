import { describe, expect, it } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createLinearTools } from "./index";
import {
  asConnection,
  lastBody,
  makeFetchStub,
  makeRoutingFetchStub,
} from "./test-helpers";

describe("linear_list_issue_labels", () => {
  it("lists issue labels with team filter", async () => {
    const nodes = [{ id: "l1", name: "Bug" }];
    const fetcher = makeFetchStub({
      data: {
        issueLabels: {
          nodes,
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      },
    });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      { id: "1", name: "linear_list_issue_labels", arguments: { team: "t1" } },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual(asConnection(nodes));
    expect(lastBody(fetcher).variables).toEqual({
      first: 25,
      filter: { team: { id: { eq: "t1" } } },
    });
  });
});

describe("linear_create_issue_label", () => {
  it("runs issueLabelCreate mutation", async () => {
    const fetcher = makeRoutingFetchStub([
      {
        includes: "issueLabelCreate",
        data: {
          issueLabelCreate: {
            success: true,
            issueLabel: { id: "l1", name: "Bug" },
          },
        },
      },
    ]);
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "1",
        name: "linear_create_issue_label",
        arguments: { name: "Bug", color: "#f00", teamId: "t1" },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.query).toContain("issueLabelCreate(input:");
    expect(body.variables).toEqual({
      input: { name: "Bug", color: "#f00", teamId: "t1" },
    });
  });
});

describe("linear_list_project_labels", () => {
  it("queries projectLabels", async () => {
    const fetcher = makeFetchStub({
      data: {
        projectLabels: {
          nodes: [],
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      },
    });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      { id: "1", name: "linear_list_project_labels", arguments: {} },
      new AbortController().signal,
    );

    expect(lastBody(fetcher).query).toContain("projectLabels(first:");
  });
});

describe("linear_list_initiative_labels", () => {
  it("queries initiativeLabels", async () => {
    const fetcher = makeFetchStub({
      data: {
        initiativeLabels: {
          nodes: [],
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      },
    });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      { id: "1", name: "linear_list_initiative_labels", arguments: {} },
      new AbortController().signal,
    );

    expect(lastBody(fetcher).query).toContain("initiativeLabels(first:");
  });
});
