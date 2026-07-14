import { describe, expect, it } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createLinearTools } from "./index";
import { lastBody, makeRoutingFetchStub } from "./test-helpers";

const issue = { id: "iss-1", identifier: "ENG-1", title: "T", url: "u" };

describe("issue write handlers", () => {
  it("linear_update_issue runs issueUpdate", async () => {
    const fetcher = makeRoutingFetchStub([
      {
        includes: "issueUpdate",
        data: { issueUpdate: { success: true, issue } },
      },
    ]);
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));
    const result = await runner.run(
      {
        id: "1",
        name: "linear_update_issue",
        arguments: { id: "ENG-1", title: "New" },
      },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(lastBody(fetcher).query).toContain("issueUpdate");
  });

  it("linear_archive_issue runs issueArchive", async () => {
    const fetcher = makeRoutingFetchStub([
      {
        includes: "issueArchive",
        data: { issueArchive: { success: true } },
      },
    ]);
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));
    const result = await runner.run(
      { id: "1", name: "linear_archive_issue", arguments: { id: "iss-1" } },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(lastBody(fetcher).query).toContain("issueArchive");
  });

  it("linear_delete_issue runs issueDelete", async () => {
    const fetcher = makeRoutingFetchStub([
      {
        includes: "issueDelete",
        data: { issueDelete: { success: true } },
      },
    ]);
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));
    const result = await runner.run(
      { id: "1", name: "linear_delete_issue", arguments: { id: "iss-1" } },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(lastBody(fetcher).query).toContain("issueDelete");
  });

  it("linear_link_issues maps type blocked to blocks with swapped ids", async () => {
    const fetcher = makeRoutingFetchStub([
      {
        includes: "issueRelationCreate",
        data: { issueRelationCreate: { success: true } },
      },
    ]);
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));
    await runner.run(
      {
        id: "1",
        name: "linear_link_issues",
        arguments: {
          action: "add",
          issueId: "a",
          relatedIssueId: "b",
          type: "blocked",
        },
      },
      new AbortController().signal,
    );
    const body = lastBody(fetcher);
    expect(body.variables.input.issueId).toBe("b");
    expect(body.variables.input.relatedIssueId).toBe("a");
    expect(body.variables.input.type).toBe("blocks");
  });

  it("linear_link_issues runs issueRelationCreate for add", async () => {
    const fetcher = makeRoutingFetchStub([
      {
        includes: "issueRelationCreate",
        data: { issueRelationCreate: { success: true } },
      },
    ]);
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));
    const result = await runner.run(
      {
        id: "1",
        name: "linear_link_issues",
        arguments: {
          action: "add",
          issueId: "a",
          relatedIssueId: "b",
          type: "blocks",
        },
      },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(lastBody(fetcher).query).toContain("issueRelationCreate");
  });
});