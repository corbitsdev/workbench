import { describe, expect, it } from "bun:test";
import { createLinearTools } from "./index";
import { asConnection, lastBody, makeRoutingFetchStub } from "./test-helpers";

function createToolRunner(tools: ReturnType<typeof createLinearTools>) {
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  return async (name: string, args: Record<string, unknown>) => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`missing tool ${name}`);
    return tool.handler(args, new AbortController().signal);
  };
}

describe("representative Linear workflows (stubbed)", () => {
  it("create issue then add comment", async () => {
    const fetcher = makeRoutingFetchStub([
      { includes: "GetTeam", data: { team: { id: "t1" } } },
      {
        includes: "issueCreate",
        data: {
          issueCreate: {
            success: true,
            issue: { id: "iss-1", identifier: "ENG-1", title: "T", url: "u" },
          },
        },
      },
      {
        includes: "commentCreate",
        data: {
          commentCreate: {
            success: true,
            comment: { id: "c-1", body: "hi" },
          },
        },
      },
    ]);
    const run = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));
    const created = await run("linear_create_issue", {
      teamId: "t1",
      title: "T",
    });
    expect(created.isError).toBeFalsy();
    const comment = await run("linear_save_comment", {
      issueId: "iss-1",
      body: "hi",
    });
    expect(comment.isError).toBeFalsy();
    const last = fetcher.mock.calls.length - 1;
    expect(lastBody(fetcher, last).query).toContain("commentCreate");
  });

  it("gets an issue with relations", async () => {
    const fetcher = makeRoutingFetchStub([
      {
        includes: "GetIssueWithRelations",
        data: {
          issue: {
            id: "iss-1",
            identifier: "ENG-1",
            title: "A",
            relations: { nodes: [] },
          },
        },
      },
    ]);
    const run = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));
    const got = await run("linear_get_issue", {
      id: "ENG-1",
      includeRelations: true,
    });
    expect(got.isError).toBeFalsy();
    expect(lastBody(fetcher).query).toContain("relations");
  });
});