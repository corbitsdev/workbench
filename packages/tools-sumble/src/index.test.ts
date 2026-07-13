import { describe, expect, it, mock } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createSumbleTools, SUMBLE_HUB_TOOLS, type SumbleFetch } from "./index";

type FetchStub = SumbleFetch & {
  mock: { calls: [string, RequestInit][] };
};

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

// A stub returning a different Response per call, driven by a queue.
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

const ALL_TOOL_NAMES = [
  "sumble_get_intelligence_brief",
  "sumble_get_org_tech_stack",
  "sumble_list_jobs",
  "sumble_list_teams",
  "sumble_resolve_organization",
  "sumble_search_organizations",
  "sumble_search_people",
  "sumble_search_signals",
];

describe("createSumbleTools", () => {
  it("exposes all eight sumble tools", () => {
    const tools = createSumbleTools({ apiKey: "k" });
    const names = tools.map((t) => t.definition.name).sort();
    expect(names).toEqual(ALL_TOOL_NAMES);
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

describe("argument-to-body mapping", () => {
  it("resolve_organization maps domain to a url org ref", async () => {
    const stub = makeFetchStub({ organizations: [{ slug: "acme" }] });
    await runTool(stub, "sumble_resolve_organization", {
      domain: "acme.com",
    });
    const body = bodyOf(stub);
    expect(body.organizations).toEqual([{ url: "acme.com" }]);
    expect((body.select as Record<string, unknown>).attributes).toContain(
      "employee_count",
    );
  });

  it("get_org_tech_stack requests technology entities with job_post_count", async () => {
    const stub = makeFetchStub({ organizations: [] });
    await runTool(stub, "sumble_get_org_tech_stack", { slug: "acme" });
    const body = bodyOf(stub);
    expect(body.organizations).toEqual([{ slug: "acme" }]);
    expect(body.select).toEqual({
      entities: [{ type: "technology", metrics: ["job_post_count"] }],
    });
  });

  it("list_teams sends organization_slug and limit", async () => {
    const stub = makeFetchStub({ teams: [] });
    await runTool(stub, "sumble_list_teams", {
      organizationSlug: "acme",
      limit: 5,
    });
    const body = bodyOf(stub);
    expect(body.teams).toEqual([{ organization_slug: "acme" }]);
    expect(body.limit).toBe(5);
    expect(body.select).toEqual({
      attributes: ["name", "icp_fit_score"],
      entities: [{ type: "job_post" }],
    });
  });

  it("search_people maps email and title into the person ref", async () => {
    const stub = makeFetchStub({ people: [] });
    await runTool(stub, "sumble_search_people", {
      email: "ceo@acme.com",
      title: "CEO",
    });
    const body = bodyOf(stub);
    expect(body.people).toEqual([{ email: "ceo@acme.com", title: "CEO" }]);
  });

  it("list_jobs sends organization_slug and job attributes", async () => {
    const stub = makeFetchStub({ jobs: [] });
    await runTool(stub, "sumble_list_jobs", { organizationSlug: "acme" });
    const body = bodyOf(stub);
    expect(body.jobs).toEqual([{ organization_slug: "acme" }]);
    expect(body.select).toEqual({
      attributes: ["title", "description", "technologies"],
    });
  });

  it("search_signals sends a filter with slug and technologies", async () => {
    const stub = makeFetchStub({ signals: [] });
    await runTool(stub, "sumble_search_signals", {
      organizationSlug: "acme",
      technologies: ["kafka", "snowflake"],
    });
    const body = bodyOf(stub);
    expect(body.filter).toEqual({
      organization_slug: "acme",
      technologies: ["kafka", "snowflake"],
    });
  });
});

describe("response parsing", () => {
  it("resolve_organization returns the matched org as STRUCTURED content", async () => {
    const stub = makeFetchStub({
      organizations: [
        { name: "Acme", slug: "acme", industry: "Software" },
        { name: "Other" },
      ],
    });
    const result = await runTool(stub, "sumble_resolve_organization", {
      slug: "acme",
    });
    expect(result.isError).toBeUndefined();
    // Structured object content (not a JSON string) so a workflow selector can
    // read `…output.content.slug` downstream.
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
    const stub = makeFetchStub({ organizations: [{ name: "Acme" }] });
    const result = await runTool(stub, "sumble_resolve_organization", {
      domain: "acme.com",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no slug");
  });

  it("resolve classifies a dotless identifier as a slug, a dotted one as a url", async () => {
    const slugStub = makeFetchStub({ organizations: [{ slug: "acme" }] });
    await runTool(slugStub, "sumble_resolve_organization", {
      identifier: "acme",
    });
    expect(bodyOf(slugStub).organizations).toEqual([{ slug: "acme" }]);

    const urlStub = makeFetchStub({ organizations: [{ slug: "acme" }] });
    await runTool(urlStub, "sumble_resolve_organization", {
      identifier: "acme.com",
    });
    expect(bodyOf(urlStub).organizations).toEqual([{ url: "acme.com" }]);
  });

  it("search_people returns a STRUCTURED { people, count }", async () => {
    const stub = makeFetchStub({
      people: [{ name: "Ada", email: "ada@acme.com" }],
    });
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
    const stub = makeFetchStub({ message: "invalid key" }, 401);
    const result = await runTool(stub, "sumble_list_jobs", {
      organizationSlug: "acme",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Sumble API error: 401");
    expect(result.content).toContain("invalid key");
  });

  it("requires at least one of domain/slug/name for resolve", async () => {
    const stub = makeFetchStub({ organizations: [] });
    const result = await runTool(stub, "sumble_resolve_organization", {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("requires one of");
    expect(stub.mock.calls).toHaveLength(0);
  });

  it("requires organizationSlug or email for search_people", async () => {
    const stub = makeFetchStub({ people: [] });
    const result = await runTool(stub, "sumble_search_people", {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("organizationSlug or email");
    expect(stub.mock.calls).toHaveLength(0);
  });
});

describe("async polling", () => {
  it("polls search_people on 202 then returns the 200 payload", async () => {
    const stub = makeSequencedFetchStub([
      { body: {}, status: 202, headers: { "Retry-After": "0" } },
      { body: { people: [{ name: "Ada", email: "ada@acme.com" }] } },
    ]);
    const result = await runTool(stub, "sumble_search_people", {
      organizationSlug: "acme",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual({
      people: [{ name: "Ada", email: "ada@acme.com" }],
      count: 1,
    });
    expect(stub.mock.calls).toHaveLength(2);
  });

  it("fails loudly when a 202 never resolves (poll-attempt cap)", async () => {
    // Always 202 with an immediate Retry-After: the poll must give up at the cap
    // and throw rather than spin forever or return an empty/partial result.
    const stub = makeSequencedFetchStub([
      { body: {}, status: 202, headers: { "Retry-After": "0" } },
    ]);
    const result = await runTool(stub, "sumble_get_intelligence_brief", {
      organizationSlug: "acme",
      confirmSpend: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("did not complete after 10");
    expect(stub.mock.calls).toHaveLength(10);
  });

  it("aborts a poll wait when the signal fires", async () => {
    // A long Retry-After the caller never waits out: aborting the run signal
    // during the wait must reject immediately, not hang for 30s.
    const stub = makeSequencedFetchStub([
      { body: {}, status: 202, headers: { "Retry-After": "30" } },
    ]);
    const controller = new AbortController();
    const runner = createToolRunner(
      createSumbleTools({ apiKey: "k", fetcher: stub }),
    );
    const pending = runner.run(
      {
        id: "call_1",
        name: "sumble_get_intelligence_brief",
        arguments: { organizationSlug: "acme", confirmSpend: true },
      },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 10);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content).toContain("aborted");
    // Only the first POST happened; the abort fired during the wait.
    expect(stub.mock.calls).toHaveLength(1);
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

  it("calls /intelligence-briefs when confirmSpend is true", async () => {
    const stub = makeFetchStub({
      organization_slug: "acme",
      brief: { summary: "hi" },
    });
    const result = await runTool(stub, "sumble_get_intelligence_brief", {
      organizationSlug: "acme",
      confirmSpend: true,
    });
    expect(result.isError).toBeUndefined();
    expect(stub.mock.calls).toHaveLength(1);
    expect(String(stub.mock.calls[0]?.[0])).toContain("/intelligence-briefs");
    expect(bodyOf(stub)).toEqual({ organization_slug: "acme" });
    expect(JSON.parse(String(result.content)).brief).toEqual({ summary: "hi" });
  });
});

describe("SUMBLE_HUB_TOOLS", () => {
  it("builds each tool from resolved credentials under the sumble provider", () => {
    const entries = Object.values(SUMBLE_HUB_TOOLS);
    expect(entries).toHaveLength(8);
    for (const entry of entries) {
      expect(entry.providerName).toBe("sumble");
      expect(entry.sideEffect).toBe("read");
      const tools = entry.createTools({
        apiKey: "k",
        baseURL: "https://api.sumble.com/v8",
      });
      expect(tools).toHaveLength(1);
      expect(tools[0]?.definition.name).toBe(entry.definition.name);
    }
  });
});
