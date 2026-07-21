import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@intx/agent";
import { createVercelTools, type VercelFetch } from "./index";

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function stringTool(name: string, fetcher: VercelFetch) {
  const tools = createVercelTools({ apiKey: "token", fetcher });
  const found = tools.find((candidate) => candidate.definition.name === name);
  if (found === undefined || found.kind !== "string") {
    throw new Error(`missing string tool ${name}`);
  }
  return found satisfies Extract<AgentTool, { kind: "string" }>;
}

describe("Vercel tools", () => {
  test("lists projects with auth, limit, and team scope", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher: VercelFetch = async (url, init) => {
      calls.push({ url, init });
      return response({ projects: [{ id: "prj_1", name: "demo" }] });
    };

    const result = await stringTool("vercel_list_projects", fetcher).handler(
      { limit: 500, teamId: "team_1" },
      new AbortController().signal,
    );

    expect(JSON.parse(result)).toEqual([{ id: "prj_1", name: "demo" }]);
    expect(calls[0]?.url).toBe(
      "https://api.vercel.com/v9/projects?limit=100&teamId=team_1",
    );
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: "Bearer token",
    });
  });

  test("lists deployments scoped by project", async () => {
    const calls: string[] = [];
    const fetcher: VercelFetch = async (url) => {
      calls.push(url);
      return response({
        deployments: [{ uid: "dpl_1", url: "demo.vercel.app", state: "READY" }],
      });
    };

    const result = await stringTool("vercel_list_deployments", fetcher).handler(
      { projectId: "prj_1", limit: 2 },
      new AbortController().signal,
    );

    expect(JSON.parse(result)).toEqual([
      { uid: "dpl_1", url: "demo.vercel.app", state: "READY" },
    ]);
    expect(calls[0]).toBe(
      "https://api.vercel.com/v6/deployments?limit=2&projectId=prj_1",
    );
  });

  test("skips the network call and reports skipped when vercel is not in enabledSources", async () => {
    const fetcher: VercelFetch = async () => {
      throw new Error("should not be called");
    };

    const result = await stringTool("vercel_list_deployments", fetcher).handler(
      { enabledSources: ["linear"] },
      new AbortController().signal,
    );

    expect(JSON.parse(result)).toEqual({ skipped: true });
  });

  test("returns a compact deployments object including target/readyState/ready/errorMessage and forwards createdAfter as since/until", async () => {
    const calls: string[] = [];
    const fetcher: VercelFetch = async (url) => {
      calls.push(url);
      return response({
        deployments: [
          {
            uid: "dpl_1",
            name: "demo",
            url: "demo.vercel.app",
            state: "READY",
            readyState: "READY",
            target: "production",
            ready: 1_770_000_000_000,
            createdAt: 1_770_000_000_000,
          },
          {
            uid: "dpl_2",
            name: "broken",
            url: "broken.vercel.app",
            readyState: "ERROR",
            target: "preview",
            errorMessage: "Build failed",
            createdAt: 1_770_000_001_000,
          },
        ],
      });
    };

    const result = await stringTool("vercel_list_deployments", fetcher).handler(
      {
        enabledSources: ["vercel"],
        createdAfter: "2026-07-04T00:00:00Z",
      },
      new AbortController().signal,
    );

    expect(JSON.parse(result)).toEqual({
      deployments: [
        {
          name: "demo",
          state: "READY",
          url: "demo.vercel.app",
          createdAt: 1_770_000_000_000,
          target: "production",
          readyState: "READY",
          ready: 1_770_000_000_000,
        },
        {
          name: "broken",
          state: "ERROR",
          url: "broken.vercel.app",
          createdAt: 1_770_000_001_000,
          target: "preview",
          readyState: "ERROR",
          ready: null,
          errorMessage: "Build failed",
        },
      ],
      truncated: false,
    });
    const url = new URL(calls[0] ?? "");
    expect(url.searchParams.get("since")).toBe(
      String(Date.parse("2026-07-04T00:00:00Z")),
    );
    expect(url.searchParams.get("until")).toBeTruthy();
  });

  test("rejects an unparseable createdAfter", async () => {
    const fetcher: VercelFetch = async () => {
      throw new Error("should not be called");
    };

    await expect(
      stringTool("vercel_list_deployments", fetcher).handler(
        { createdAfter: "not-a-date" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(
      'vercel_list_deployments: createdAfter is not a parseable date: "not-a-date"',
    );
  });

  test("sends both since and until when createdAfter is valid", async () => {
    const calls: string[] = [];
    const fetcher: VercelFetch = async (url) => {
      calls.push(url);
      return response({ deployments: [] });
    };

    const before = Date.now();
    await stringTool("vercel_list_deployments", fetcher).handler(
      { createdAfter: "2026-07-04T00:00:00Z" },
      new AbortController().signal,
    );
    const after = Date.now();

    const url = new URL(calls[0] ?? "");
    expect(url.searchParams.get("since")).toBe(
      String(Date.parse("2026-07-04T00:00:00Z")),
    );
    const until = Number(url.searchParams.get("until"));
    expect(until).toBeGreaterThanOrEqual(before);
    expect(until).toBeLessThanOrEqual(after);
  });

  test("raises the default limit to 100 on the brief-shaped path", async () => {
    const calls: string[] = [];
    const fetcher: VercelFetch = async (url) => {
      calls.push(url);
      return response({ deployments: [] });
    };

    await stringTool("vercel_list_deployments", fetcher).handler(
      { enabledSources: ["vercel"] },
      new AbortController().signal,
    );

    const url = new URL(calls[0] ?? "");
    expect(url.searchParams.get("limit")).toBe("100");
  });

  test("keeps the default limit at 20 outside the brief-shaped path", async () => {
    const calls: string[] = [];
    const fetcher: VercelFetch = async (url) => {
      calls.push(url);
      return response({ deployments: [] });
    };

    await stringTool("vercel_list_deployments", fetcher).handler(
      {},
      new AbortController().signal,
    );

    const url = new URL(calls[0] ?? "");
    expect(url.searchParams.get("limit")).toBe("20");
  });

  test("marks truncated when pagination.next is beyond the since cutoff", async () => {
    const sinceIso = "2026-07-04T00:00:00Z";
    const sinceMillis = Date.parse(sinceIso);
    const fetcher: VercelFetch = async () =>
      response({
        deployments: [],
        pagination: { next: sinceMillis + 1000 },
      });

    const result = await stringTool("vercel_list_deployments", fetcher).handler(
      { enabledSources: ["vercel"], createdAfter: sinceIso },
      new AbortController().signal,
    );

    expect(JSON.parse(result).truncated).toBe(true);
  });

  test("does not mark truncated when pagination.next is null or before the since cutoff", async () => {
    const sinceIso = "2026-07-04T00:00:00Z";
    const sinceMillis = Date.parse(sinceIso);
    const fetcher: VercelFetch = async () =>
      response({
        deployments: [],
        pagination: { next: sinceMillis - 1000 },
      });

    const result = await stringTool("vercel_list_deployments", fetcher).handler(
      { enabledSources: ["vercel"], createdAfter: sinceIso },
      new AbortController().signal,
    );

    expect(JSON.parse(result).truncated).toBe(false);
  });

  test("passes target and state through as query params", async () => {
    const calls: string[] = [];
    const fetcher: VercelFetch = async (url) => {
      calls.push(url);
      return response({ deployments: [] });
    };

    await stringTool("vercel_list_deployments", fetcher).handler(
      { target: "production", state: "READY,ERROR" },
      new AbortController().signal,
    );

    const url = new URL(calls[0] ?? "");
    expect(url.searchParams.get("target")).toBe("production");
    expect(url.searchParams.get("state")).toBe("READY,ERROR");
  });

  test("deploys a static file as a preview deployment", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetcher: VercelFetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return response({
        id: "dpl_1",
        url: "demo.vercel.app",
        readyState: "QUEUED",
      });
    };

    const result = await stringTool(
      "vercel_deploy_static_file",
      fetcher,
    ).handler(
      {
        projectName: "demo",
        filePath: "/index.html",
        html: "<h1>Hello</h1>",
        teamId: "team_1",
      },
      new AbortController().signal,
    );

    expect(JSON.parse(result)).toEqual({
      id: "dpl_1",
      url: "https://demo.vercel.app",
      readyState: "QUEUED",
    });
    expect(calls[0]?.url).toBe(
      "https://api.vercel.com/v13/deployments?teamId=team_1",
    );
    expect(calls[0]?.body).toEqual({
      name: "demo",
      target: "preview",
      projectSettings: { framework: null },
      files: [
        {
          file: "index.html",
          data: Buffer.from("<h1>Hello</h1>", "utf8").toString("base64"),
          encoding: "base64",
        },
      ],
    });
  });

  test("rejects a deployment whose path escapes the deployment root", async () => {
    const fetcher: VercelFetch = async () => {
      throw new Error("fetch should not run");
    };

    await expect(
      stringTool("vercel_deploy_static_file", fetcher).handler(
        {
          projectName: "demo",
          filePath: "../secrets.html",
          html: "<h1>Hello</h1>",
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("filePath must be a relative file path without '..'");
  });

  test("rejects a deployment whose HTML exceeds the size ceiling", async () => {
    const fetcher: VercelFetch = async () => {
      throw new Error("fetch should not run");
    };

    await expect(
      stringTool("vercel_deploy_static_file", fetcher).handler(
        {
          projectName: "demo",
          filePath: "index.html",
          html: "a".repeat(4_500_001),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("too large");
  });

  test("rejects construction with an empty apiKey", () => {
    expect(() =>
      createVercelTools({ apiKey: "", fetcher: async () => response({}) }),
    ).toThrow("Vercel apiKey is required");
  });

  test("rejects construction with an invalid baseUrl", () => {
    expect(() =>
      createVercelTools({
        apiKey: "token",
        baseUrl: "not a url",
        fetcher: async () => response({}),
      }),
    ).toThrow("Vercel baseUrl must be a valid URL");
  });

  test("surfaces Vercel API errors", async () => {
    const fetcher: VercelFetch = async () =>
      response(
        { error: { message: "forbidden" } },
        { status: 403, statusText: "Forbidden" },
      );

    await expect(
      stringTool("vercel_list_projects", fetcher).handler(
        {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("Vercel API error: 403 forbidden");
  });
});
