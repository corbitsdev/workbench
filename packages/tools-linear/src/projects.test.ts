import { describe, expect, it } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createLinearTools } from "./index";
import { asConnection, lastBody, makeFetchStub } from "./test-helpers";

describe("linear_list_projects", () => {
  it("lists projects with default pagination", async () => {
    const nodes = [{ id: "p1", name: "Alpha", slug: "alpha" }];
    const fetcher = makeFetchStub({ data: { projects: { nodes } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      { id: "c1", name: "linear_list_projects", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual(asConnection(nodes));
    const body = lastBody(fetcher);
    expect(body.query).toContain("projects(first:");
    expect(body.variables).toEqual({ first: 25 });
  });

  it("forwards query and team as ProjectFilter", async () => {
    const fetcher = makeFetchStub({ data: { projects: { nodes: [] } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "c1",
        name: "linear_list_projects",
        arguments: { query: "roadmap", team: "team-uuid" },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.variables).toEqual({
      first: 25,
      filter: {
        name: { containsIgnoreCase: "roadmap" },
        teams: { id: { eq: "team-uuid" } },
      },
    });
  });
});

describe("linear_get_project", () => {
  it("fetches a project by id", async () => {
    const project = { id: "p1", name: "Alpha", slug: "alpha", url: "u" };
    const fetcher = makeFetchStub({ data: { project } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      { id: "c1", name: "linear_get_project", arguments: { id: "p1" } },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual(project);
    const body = lastBody(fetcher);
    expect(body.query).toContain("project(id: $id)");
    expect(body.variables).toEqual({ id: "p1" });
  });

  it("errors when project is missing", async () => {
    const fetcher = makeFetchStub({ data: { project: null } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      { id: "c1", name: "linear_get_project", arguments: { id: "missing" } },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Linear project not found: missing");
  });
});

describe("linear_save_project", () => {
  it("runs projectCreate when id is omitted", async () => {
    const fetcher = makeFetchStub({
      data: {
        projectCreate: {
          success: true,
          project: { id: "p-new", name: "Beta", slug: "beta", url: "u" },
        },
      },
    });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "c1",
        name: "linear_save_project",
        arguments: { name: "Beta", teamIds: ["t1"], description: "desc" },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.query).toContain("projectCreate(input: $input)");
    expect(body.variables).toEqual({
      input: { name: "Beta", teamIds: ["t1"], description: "desc" },
    });
  });

  it("runs projectUpdate when id is provided", async () => {
    const fetcher = makeFetchStub({
      data: { projectUpdate: { success: true, project: { id: "p1" } } },
    });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "c1",
        name: "linear_save_project",
        arguments: { id: "p1", name: "Renamed", state: "started" },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.query).toContain("projectUpdate(id: $id");
    expect(body.variables).toEqual({
      id: "p1",
      input: { name: "Renamed", state: "started" },
    });
  });
});
