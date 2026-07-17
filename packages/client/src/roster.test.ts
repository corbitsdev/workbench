/// <reference types="bun" />
// Contract tests for the principal-roster client function: URL construction
// under the tenant-scoped `/api` prefix, boundary parsing through the exported
// arktype schema, and the malformed-body error path.
import { describe, expect, it, mock } from "bun:test";
import "./test-setup";
import { getPrincipalRoster, getTenantRoster } from "./index";

type FetchArgs = [input: string | URL | Request, init?: RequestInit];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFetch(impl: (...args: FetchArgs) => Promise<Response>) {
  const spy = mock(impl);
  const fetcher = Object.assign(
    (input: FetchArgs[0], init?: FetchArgs[1]) => spy(input, init),
    { preconnect: mock(() => {}) },
  ) as unknown as typeof fetch;
  return { spy, fetcher };
}

const BASE = "http://localhost:4000";

describe("getPrincipalRoster", () => {
  const roster = {
    instances: [
      {
        instanceId: "ins_1",
        principalId: "prn_syn_1",
        agentId: "agt_1",
        name: "Myra",
        status: "running",
        sessionCount: 4,
      },
    ],
    runs: [{ runId: "run_1", kind: "last30days", status: "completed" }],
  };

  it("builds the tenant-scoped roster URL under /api", async () => {
    const { spy, fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse({ instances: [], runs: [] })),
    );

    await getPrincipalRoster(
      { baseUrl: BASE, fetch: fetcher },
      { tenantId: "ten/1", principalId: "prn_1" },
    );

    expect(spy.mock.calls[0]?.[0]).toBe(
      `${BASE}/api/tenants/ten%2F1/principals/prn_1/roster`,
    );
  });

  it("parses the instances and runs through the boundary schema", async () => {
    const { fetcher } = makeFetch(() => Promise.resolve(jsonResponse(roster)));

    const result = await getPrincipalRoster(
      { baseUrl: BASE, fetch: fetcher },
      { tenantId: "ten_1", principalId: "prn_1" },
    );

    expect(result.instances[0]?.principalId).toBe("prn_syn_1");
    expect(result.instances[0]?.sessionCount).toBe(4);
    expect(result.runs[0]?.runId).toBe("run_1");
  });

  it("rejects a malformed body (session count wrong type)", async () => {
    const { fetcher } = makeFetch(() =>
      Promise.resolve(
        jsonResponse({
          instances: [{ ...roster.instances[0], sessionCount: "lots" }],
          runs: [],
        }),
      ),
    );

    await expect(
      getPrincipalRoster(
        { baseUrl: BASE, fetch: fetcher },
        { tenantId: "ten_1", principalId: "prn_1" },
      ),
    ).rejects.toThrow(/Invalid \/roster response/);
  });
});

describe("getTenantRoster", () => {
  const roster = {
    instances: [
      {
        instanceId: "ins_1",
        principalId: "prn_syn_1",
        agentId: "agt_1",
        name: "Myra",
        status: "running",
        sessionCount: 4,
      },
    ],
    runs: [{ runId: "run_1", kind: "last30days", status: "completed" }],
  };

  it("builds the tenant-scoped roster URL under /api", async () => {
    const { spy, fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse({ instances: [], runs: [] })),
    );

    await getTenantRoster(
      { baseUrl: BASE, fetch: fetcher },
      { tenantId: "ten/1" },
    );

    expect(spy.mock.calls[0]?.[0]).toBe(`${BASE}/api/tenants/ten%2F1/roster`);
  });

  it("parses the instances and runs through the boundary schema", async () => {
    const { fetcher } = makeFetch(() => Promise.resolve(jsonResponse(roster)));

    const result = await getTenantRoster(
      { baseUrl: BASE, fetch: fetcher },
      { tenantId: "ten_1" },
    );

    expect(result.instances[0]?.principalId).toBe("prn_syn_1");
    expect(result.runs[0]?.runId).toBe("run_1");
  });

  it("rejects a malformed body (run missing kind)", async () => {
    const { fetcher } = makeFetch(() =>
      Promise.resolve(
        jsonResponse({
          instances: [],
          runs: [{ runId: "run_1", status: "completed" }],
        }),
      ),
    );

    await expect(
      getTenantRoster({ baseUrl: BASE, fetch: fetcher }, { tenantId: "ten_1" }),
    ).rejects.toThrow(/Invalid \/roster response/);
  });
});
