import { describe, expect, it } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createLinearTools } from "./index";
import { asConnection, lastBody, makeFetchStub } from "./test-helpers";

describe("linear_list_milestones", () => {
  it("lists milestones under a project", async () => {
    const nodes = [{ id: "m1", name: "M1", targetDate: "2026-12-01" }];
    const fetcher = makeFetchStub({
      data: { project: { projectMilestones: { nodes } } },
    });
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));

    const result = await runner.run(
      {
        id: "c1",
        name: "linear_list_milestones",
        arguments: { project: "proj-1" },
      },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual(asConnection(nodes));
    const body = lastBody(fetcher);
    expect(body.query).toContain("project(id: $projectId)");
    expect(body.query).toContain("projectMilestones(first:");
    expect(body.variables).toEqual({ projectId: "proj-1", first: 25 });
  });

  it("errors when project is not found", async () => {
    const fetcher = makeFetchStub({ data: { project: null } });
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));

    const result = await runner.run(
      {
        id: "c1",
        name: "linear_list_milestones",
        arguments: { project: "bad" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Linear project not found: bad");
  });
});

describe("linear_save_milestone", () => {
  it("runs projectMilestoneCreate without id", async () => {
    const fetcher = makeFetchStub({
      data: {
        projectMilestoneCreate: {
          success: true,
          projectMilestone: { id: "m1", name: "Ship" },
        },
      },
    });
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));

    await runner.run(
      {
        id: "c1",
        name: "linear_save_milestone",
        arguments: {
          project: "proj-1",
          name: "Ship",
          targetDate: "2026-06-01",
        },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.query).toContain("projectMilestoneCreate(input: $input)");
    expect(body.variables).toEqual({
      input: {
        name: "Ship",
        projectId: "proj-1",
        targetDate: "2026-06-01",
      },
    });
  });

  it("runs projectMilestoneUpdate with id", async () => {
    const fetcher = makeFetchStub({
      data: {
        projectMilestoneUpdate: {
          success: true,
          projectMilestone: { id: "m1", name: "Done" },
        },
      },
    });
    const runner = createToolRunner(createLinearTools({ apiKey: "k", fetcher }));

    await runner.run(
      {
        id: "c1",
        name: "linear_save_milestone",
        arguments: { id: "m1", project: "proj-1", name: "Done" },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.query).toContain("projectMilestoneUpdate(id: $id");
    expect(body.variables).toEqual({
      id: "m1",
      input: { name: "Done", projectId: "proj-1" },
    });
  });
});