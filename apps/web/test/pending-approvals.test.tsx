// The client-side composer behind every approval surface: the platform's
// pending list, named through the run view and the account's own
// membership. What matters here is that a run is named once no matter how
// many approvals it raised, that a refused list read is shown as a failure
// rather than an empty queue, and that the chat card's status read speaks
// the same display model.

import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { createChatApprovalActions } from "../src/approval-actions";
import { BenchContext, type BenchState } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import { MissionControlRoute } from "../src/pages/mission-control-page";
import { usePendingApprovals } from "../src/pending-approvals";
import { TestQueryProvider } from "./test-query-provider";

const realFetch = globalThis.fetch;
const TENANT_ID = "tnt_1";

const benchState: BenchState = {
  memberships: {
    kind: "ready",
    data: {
      data: [
        {
          principalId: "prn_1",
          tenantId: TENANT_ID,
          tenantName: "Growth Team Bench",
          tenantSlug: "growth-team-bench",
          kind: "user",
          status: "active",
          roles: [],
        },
      ],
      nextCursor: null,
    },
  },
  selectedTenantId: TENANT_ID,
  selectedPrincipalId: "prn_1",
  selectTenant: () => undefined,
  onBenchCreated: () => undefined,
};

function approvalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "apr_1",
    tenantId: TENANT_ID,
    anchorRunId: "run_1",
    runId: "run_1",
    agentAddress: "researcher@growth",
    correlationId: "cor_1",
    toolDefinition: {
      name: "send_email",
      description: "Sends an email on the tenant's behalf",
    },
    toolArguments: { title: "Welcome Acme" },
    scope: null,
    status: "pending",
    timeoutAt: null,
    resolvedAt: null,
    createdAt: "2026-08-20T09:00:00.000Z",
    updatedAt: "2026-08-20T09:00:00.000Z",
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Every path the stub was asked for, in order — the evidence that a run is
 * named once per run and not once per approval. */
let requested: string[] = [];

function stubFetch(
  handler: (path: string) => Response | undefined,
  fallback: Response = json({ items: [], data: [], nextCursor: null }),
): void {
  requested = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    requested.push(path);
    return Promise.resolve(handler(path) ?? fallback.clone());
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Renders exactly what the composer produced, so the assertions read the
 * display model the way a card does. */
function ApprovalNames() {
  const approvals = usePendingApprovals(TENANT_ID);
  if (approvals.kind !== "ready") return <p>{approvals.kind}</p>;
  return (
    <ul>
      {approvals.data.map((approval) => (
        <li key={approval.id}>
          {approval.agentName} in {approval.benchName}: {approval.headline}
        </li>
      ))}
    </ul>
  );
}

describe("usePendingApprovals", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root !== null) {
      act(() => root?.unmount());
      root = null;
    }
    container?.remove();
    container = null;
  });

  async function mount(children: React.ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TestQueryProvider>
          <NavigationProvider navigate={() => undefined}>
            <BenchContext.Provider value={benchState}>
              {children}
            </BenchContext.Provider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
    for (let tick = 0; tick < 10; tick += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    return container;
  }

  test("names both of one run's approvals from a single run-view read", async () => {
    stubFetch((path) => {
      if (path === `/api/tenants/${TENANT_ID}/approvals`) {
        return json({
          data: [approvalRow(), approvalRow({ id: "apr_2" })],
          nextCursor: null,
        });
      }
      if (path === `/api/tenants/${TENANT_ID}/runs/run_1`) {
        return json({
          id: "run_1",
          definitionId: "def_1",
          definitionName: "Research Analyst",
          tenantId: TENANT_ID,
          address: "researcher@growth",
          status: "running",
          createdAt: "2026-08-20T08:00:00.000Z",
          updatedAt: "2026-08-20T08:00:00.000Z",
        });
      }
      return undefined;
    });

    const el = await mount(<ApprovalNames />);

    const items = [...el.querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toEqual([
      'Research Analyst in Growth Team Bench: Sends an email on the tenant\'s behalf: "Welcome Acme"',
      'Research Analyst in Growth Team Bench: Sends an email on the tenant\'s behalf: "Welcome Acme"',
    ]);
    expect(
      requested.filter((path) => path.includes("/runs/run_1")),
    ).toHaveLength(1);
  });

  test("a refused list read reads as a failure, never as an empty queue", async () => {
    stubFetch((path) => {
      if (path === `/api/tenants/${TENANT_ID}/approvals`) {
        return json({ error: { code: "forbidden", message: "no" } }, 403);
      }
      if (path.includes("/insights/activity")) return json({ days: [] });
      return undefined;
    });

    const el = await mount(<MissionControlRoute navigate={() => undefined} />);

    expect(el.textContent).toContain("Couldn't load approvals");
    expect(el.textContent).not.toContain("Nothing waiting on you");
  });
});

describe("chat approve card status read", () => {
  function actions() {
    return createChatApprovalActions(TENANT_ID, new QueryClient());
  }

  test("a pending approval is actionable, named, and headlined", async () => {
    stubFetch((path) => {
      if (path === `/api/tenants/${TENANT_ID}/approvals/apr_1`) {
        return json(approvalRow());
      }
      if (path === `/api/tenants/${TENANT_ID}/runs/run_1`) {
        return json({
          id: "run_1",
          definitionId: "def_1",
          definitionName: "Research Analyst",
          tenantId: TENANT_ID,
          address: "researcher@growth",
          status: "running",
          createdAt: "2026-08-20T08:00:00.000Z",
          updatedAt: "2026-08-20T08:00:00.000Z",
        });
      }
      return undefined;
    });

    expect(await actions().getStatus("apr_1")).toEqual({
      kind: "ready",
      status: "pending",
      canAct: true,
      detail: {
        agentName: "Research Analyst",
        headline: 'Sends an email on the tenant\'s behalf: "Welcome Acme"',
        arguments: { title: "Welcome Acme" },
      },
    });
  });

  test("a refused read is forbidden", async () => {
    stubFetch(() => json({ error: { code: "forbidden" } }, 403));
    expect(await actions().getStatus("apr_1")).toEqual({ kind: "forbidden" });
  });

  test("an unknown approval is not-found", async () => {
    stubFetch(() => json({ error: { code: "not_found" } }, 404));
    expect(await actions().getStatus("apr_1")).toEqual({ kind: "not-found" });
  });
});
