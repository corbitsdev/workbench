import { describe, expect, it, mock } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { estimatePeopleEmailRevealCredits } from "./credits";
import {
  API_VERSION,
  createSumbleTools,
  SUMBLE_HUB_TOOLS,
  SUMBLE_TOOL_SPECS,
  type SumbleFetch,
} from "./index";

type FetchStub = SumbleFetch & {
  mock: { calls: [string, RequestInit][] };
};

function orgResolveBody(slug = "acme", id = 42): unknown {
  return { organizations: [{ attributes: { id, slug } }] };
}

function makeFetchStub(response: unknown, status = 200): FetchStub {
  return mock((_input: string, _init: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

function makeSequencedFetchStub(
  responses: {
    body: unknown;
    status?: number;
    headers?: Record<string, string>;
  }[],
): FetchStub {
  let index = 0;
  return mock((_input: string, _init: RequestInit) => {
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(
      new Response(JSON.stringify(next?.body ?? {}), {
        status: next?.status ?? 200,
        headers: { "Content-Type": "application/json", ...next?.headers },
      }),
    );
  });
}

function bodyOf(stub: FetchStub, call = 0): Record<string, unknown> {
  return JSON.parse(String(stub.mock.calls[call]?.[1].body));
}

function urlOf(stub: FetchStub, call = 0): string {
  return String(stub.mock.calls[call]?.[0]);
}

const EXPECTED_TOOL_COUNT = SUMBLE_TOOL_SPECS.length;

describe("createSumbleTools", () => {
  it("exposes every registered sumble tool", () => {
    const tools = createSumbleTools({ apiKey: "k" });
    expect(tools).toHaveLength(EXPECTED_TOOL_COUNT);
    const names = tools.map((t) => t.definition.name).sort();
    const expected = SUMBLE_TOOL_SPECS.map((s) => s.definition.name).sort();
    expect(names).toEqual(expected);
  });

  it("throws when apiKey is empty", () => {
    expect(() => createSumbleTools({ apiKey: "" })).toThrow(
      "Sumble apiKey is required",
    );
  });

  it("throws when baseUrl is invalid", () => {
    expect(() =>
      createSumbleTools({ apiKey: "k", baseUrl: "not-a-url" }),
    ).toThrow("Sumble baseUrl must be a valid URL");
  });
});

async function runTool(
  stub: FetchStub,
  name: string,
  args: Record<string, unknown>,
) {
  const runner = createToolRunner(
    createSumbleTools({ apiKey: "k", fetcher: stub }),
  );
  return runner.run(
    { id: "call_1", name, arguments: args },
    new AbortController().signal,
  );
}

describe("v9 argument-to-body mapping", () => {
  it("resolve_organization maps domain to a url org ref", async () => {
    const stub = makeFetchStub(orgResolveBody());
    await runTool(stub, "sumble_resolve_organization", {
      domain: "acme.com",
    });
    const body = bodyOf(stub);
    expect(body.organizations).toEqual([{ url: "acme.com" }]);
    expect(urlOf(stub)).toContain(`/${API_VERSION}/organizations`);
  });

  it("get_org_tech_stack resolves org then queries teams for technology_list", async () => {
    const stub = makeSequencedFetchStub([
      { body: orgResolveBody() },
      { body: { teams: [] } },
    ]);
    await runTool(stub, "sumble_get_org_tech_stack", { slug: "acme" });
    expect(bodyOf(stub, 1).filter).toEqual({ organization_ids: [42] });
    expect(bodyOf(stub, 1).select).toEqual({
      attributes: ["name", "technology_list", "jobs_count"],
    });
  });

  it("list_teams sends organization_ids filter", async () => {
    const stub = makeSequencedFetchStub([
      { body: orgResolveBody() },
      { body: { teams: [] } },
    ]);
    await runTool(stub, "sumble_list_teams", {
      organizationSlug: "acme",
      limit: 5,
    });
    expect(bodyOf(stub, 1).filter).toEqual({ organization_ids: [42] });
    expect(bodyOf(stub, 1).limit).toBe(5);
    expect(bodyOf(stub, 1).select).toEqual({
      attributes: ["name", "score", "jobs_count"],
    });
  });

  it("list_teams accepts organizationId without slug", async () => {
    const stub = makeFetchStub({ teams: [] });
    await runTool(stub, "sumble_list_teams", { organizationId: 42 });
    expect(stub.mock.calls).toHaveLength(1);
    expect(bodyOf(stub).filter).toEqual({ organization_ids: [42] });
  });

  it("search_people maps email into list-mode person ref", async () => {
    const stub = makeFetchStub({ people: [] });
    await runTool(stub, "sumble_search_people", {
      email: "ceo@acme.com",
      confirmEmailRevealSpend: true,
    });
    const body = bodyOf(stub);
    expect(body.people).toEqual([{ email: "ceo@acme.com" }]);
    expect(body.select).toEqual({
      attributes: ["name", "job_title", "linkedin_url"],
    });
  });

  it("post_people blocks email in select without confirmEmailRevealSpend", async () => {
    const stub = makeFetchStub({ people: [] });
    const result = await runTool(stub, "sumble_post_people", {
      body: { select: { attributes: ["email"] } },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("confirmEmailRevealSpend");
    expect(stub.mock.calls).toHaveLength(0);
  });

  it("post_people blocks phone in select without confirmEmailRevealSpend", async () => {
    const stub = makeFetchStub({ people: [] });
    const result = await runTool(stub, "sumble_post_people", {
      body: { select: { attributes: ["phone"] } },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("confirmEmailRevealSpend");
    expect(stub.mock.calls).toHaveLength(0);
  });

  it("find_technologies sends query string to POST /technologies/find", async () => {
    const stub = makeFetchStub({ technologies: [] });
    await runTool(stub, "sumble_find_technologies", { terms: ["python", "ml"] });
    expect(bodyOf(stub)).toEqual({ query: "python ml" });
  });

  it("list_jobs sends organization_ids filter", async () => {
    const stub = makeSequencedFetchStub([
      { body: orgResolveBody() },
      { body: { jobs: [] } },
    ]);
    await runTool(stub, "sumble_list_jobs", { organizationSlug: "acme" });
    expect(bodyOf(stub, 1).filter).toEqual({ organization_ids: [42] });
    expect(bodyOf(stub, 1).select).toEqual({
      attributes: ["title", "description", "technologies"],
    });
  });

  it("search_signals sends technology_slugs on the filter", async () => {
    const stub = makeSequencedFetchStub([
      { body: orgResolveBody() },
      { body: { signals: [] } },
    ]);
    await runTool(stub, "sumble_search_signals", {
      organizationSlug: "acme",
      technologySlugs: ["kafka", "snowflake"],
    });
    expect(bodyOf(stub, 1).filter).toEqual({
      organization_ids: [42],
      technology_slugs: ["kafka", "snowflake"],
    });
  });
});

describe("response parsing", () => {
  it("resolve_organization returns flattened attributes as STRUCTURED content", async () => {
    const stub = makeFetchStub({
      organizations: [
        {
          attributes: { name: "Acme", slug: "acme", industry: "Software" },
        },
      ],
    });
    const result = await runTool(stub, "sumble_resolve_organization", {
      slug: "acme",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual({
      name: "Acme",
      slug: "acme",
      industry: "Software",
    });
  });

  it("resolve_organization fails loudly when nothing matches", async () => {
    const stub = makeFetchStub({ organizations: [] });
    const result = await runTool(stub, "sumble_resolve_organization", {
      slug: "nope",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no organization matched");
  });

  it("resolve_organization fails loudly when the match has no slug", async () => {
    const stub = makeFetchStub({
      organizations: [{ attributes: { name: "Acme" } }],
    });
    const result = await runTool(stub, "sumble_resolve_organization", {
      domain: "acme.com",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no slug");
  });

  it("search_people returns a STRUCTURED { people, count }", async () => {
    const stub = makeSequencedFetchStub([
      { body: orgResolveBody() },
      {
        body: {
          people: [{ attributes: { name: "Ada", email: "ada@acme.com" } }],
        },
      },
    ]);
    const result = await runTool(stub, "sumble_search_people", {
      organizationSlug: "acme",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual({
      people: [{ name: "Ada", email: "ada@acme.com" }],
      count: 1,
    });
  });
});

describe("error handling", () => {
  it("surfaces a 401 as a Sumble API error", async () => {
    const stub = makeSequencedFetchStub([
      { body: orgResolveBody() },
      { body: { message: "invalid key" }, status: 401 },
    ]);
    const result = await runTool(stub, "sumble_list_jobs", {
      organizationSlug: "acme",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Sumble API error: 401");
    expect(result.content).toContain("invalid key");
  });

  it("requires at least one identifier for resolve", async () => {
    const stub = makeFetchStub({ organizations: [] });
    const result = await runTool(stub, "sumble_resolve_organization", {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("requires one of");
    expect(stub.mock.calls).toHaveLength(0);
  });

  it("requires organization or person ref for search_people", async () => {
    const stub = makeFetchStub({ people: [] });
    const result = await runTool(stub, "sumble_search_people", {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("requires organizationSlug");
    expect(stub.mock.calls).toHaveLength(0);
  });
});

describe("async polling", () => {
  it("polls search_people with the request_id, not a re-POST of the body", async () => {
    const stub = makeSequencedFetchStub([
      { body: orgResolveBody() },
      {
        body: { status: "pending", request_id: "req_1" },
        headers: { "Retry-After": "0" },
      },
      {
        body: {
          people: [{ attributes: { name: "Ada", email: "ada@acme.com" } }],
        },
      },
    ]);
    const result = await runTool(stub, "sumble_search_people", {
      organizationSlug: "acme",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual({
      people: [{ name: "Ada", email: "ada@acme.com" }],
      count: 1,
    });
    expect(stub.mock.calls).toHaveLength(3);
    expect(bodyOf(stub, 2)).toEqual({ request_id: "req_1" });
  });

  it("fails loudly when a 202 never resolves (poll-attempt cap)", async () => {
    const stub = makeSequencedFetchStub([
      { body: orgResolveBody() },
      { body: {}, status: 202, headers: { "Retry-After": "0" } },
    ]);
    const result = await runTool(stub, "sumble_get_intelligence_brief", {
      organizationSlug: "acme",
      confirmSpend: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("did not complete after 10");
  });
});

describe("people credit gates", () => {
  it("estimatePeopleEmailRevealCredits multiplies by 10", () => {
    expect(estimatePeopleEmailRevealCredits(3)).toBe(30);
  });

  it("search_people blocks revealEmail without confirmEmailRevealSpend", async () => {
    const stub = makeFetchStub({ people: [] });
    const result = await runTool(stub, "sumble_search_people", {
      organizationSlug: "acme",
      revealEmail: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("confirmEmailRevealSpend");
    expect(stub.mock.calls).toHaveLength(0);
  });

  it("search_people blocks email lookup without confirmEmailRevealSpend", async () => {
    const stub = makeFetchStub({ people: [] });
    const result = await runTool(stub, "sumble_search_people", {
      email: "ceo@acme.com",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("confirmEmailRevealSpend");
    expect(stub.mock.calls).toHaveLength(0);
  });
});

describe("intelligence brief cost gate", () => {
  it("refuses without confirmSpend and never calls the API", async () => {
    const stub = makeFetchStub({ brief: {} });
    const result = await runTool(stub, "sumble_get_intelligence_brief", {
      organizationSlug: "acme",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("50 credits");
    expect(stub.mock.calls).toHaveLength(0);
  });

  it("GETs /v9/organizations/{id}/intelligence-brief when confirmSpend is true", async () => {
    const stub = makeSequencedFetchStub([
      { body: orgResolveBody() },
      { body: { brief: { summary: "hi" } } },
    ]);
    const result = await runTool(stub, "sumble_get_intelligence_brief", {
      organizationSlug: "acme",
      confirmSpend: true,
    });
    expect(result.isError).toBeUndefined();
    expect(urlOf(stub, 1)).toContain(`/v9/organizations/42/intelligence-brief`);
    expect(JSON.parse(String(result.content)).brief).toEqual({ summary: "hi" });
  });
});

describe("SUMBLE_HUB_TOOLS", () => {
  it("builds each tool from resolved credentials under the sumble provider", () => {
    const entries = Object.values(SUMBLE_HUB_TOOLS);
    expect(entries).toHaveLength(EXPECTED_TOOL_COUNT);
    const writeTools = entries.filter((e) => e.sideEffect === "write");
    expect(writeTools.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.providerName).toBe("sumble");
      const tools = entry.createTools({
        apiKey: "k",
        baseURL: "https://api.sumble.com",
      });
      expect(tools).toHaveLength(1);
      expect(tools[0]?.definition.name).toBe(entry.definition.name);
    }
  });
});
