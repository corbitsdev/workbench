// Keeper for the workbench-only home: `/` is a hop, never a guess. A live
// last-visited id hops to `/w/:id`; a missing or stale id (and an empty
// list) falls through to the picker — array order is never treated as
// recency.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { BenchContext, type BenchState } from "../bench-context";
import { recordLastWorkbenchId } from "../last-workbench";
import { NavigationProvider } from "../navigation";
import { TestQueryProvider } from "../test-query-provider";
import { HomeRoute } from "./home-page";

const TENANT_ID = "tnt_bench";
const realFetch = globalThis.fetch;

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
  benchMemberships: [
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
  selectedTenantId: TENANT_ID,
  selectedPrincipalId: "prn_1",
  selectTenant: () => undefined,
  onBenchCreated: () => undefined,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ownerMembership(tenantId: string, tenantName: string) {
  return {
    principalId: `prn_${tenantId}`,
    tenantId,
    tenantName,
    tenantSlug: tenantId,
    kind: "user",
    status: "active",
    roles: [{ id: "rol_owner", name: "owner" }],
  };
}

function tenantRow(id: string, name: string, parentId: string | null) {
  return { id, name, slug: id, domain: "bench.test", parentId };
}

/** Serves the `findOwnedTenants` chain (`/api/me/principals`, then one
 * `/api/tenants/:id` per owned membership) for the given workbench ids. */
function stubWorkbenches(workbenchIds: readonly string[]): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    if (path.startsWith("/api/me/principals")) {
      return Promise.resolve(
        json({
          data: [
            ownerMembership(TENANT_ID, "Growth Team Bench"),
            ...workbenchIds.map((id) => ownerMembership(id, `Workbench ${id}`)),
          ],
          nextCursor: null,
        }),
      );
    }
    if (path === `/api/tenants/${TENANT_ID}`) {
      return Promise.resolve(json(tenantRow(TENANT_ID, "Growth Team Bench", null)));
    }
    const match = /^\/api\/tenants\/([^/]+)$/.exec(path);
    if (match?.[1] !== undefined && workbenchIds.includes(match[1])) {
      return Promise.resolve(json(tenantRow(match[1], `Workbench ${match[1]}`, TENANT_ID)));
    }
    return Promise.resolve(json({ error: { code: "not-found" } }, 404));
  }) as typeof fetch;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  globalThis.fetch = realFetch;
  window.sessionStorage.clear();
});

async function navigatedTo(workbenchIds: readonly string[]): Promise<readonly string[]> {
  stubWorkbenches(workbenchIds);
  const navigated: string[] = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TestQueryProvider>
        <NavigationProvider navigate={(to) => navigated.push(to)}>
          <BenchContext.Provider value={benchState}>
            <HomeRoute />
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
  return navigated;
}

describe("HomeRoute", () => {
  test("a live last id hops to that workbench", async () => {
    recordLastWorkbenchId(TENANT_ID, "wb_2");
    expect(await navigatedTo(["wb_1", "wb_2"])).toEqual(["/w/wb_2"]);
  });

  test("a missing last id falls through to the picker, never the first workbench", async () => {
    const navigated = await navigatedTo(["wb_1", "wb_2"]);
    expect(navigated).toEqual(["/new"]);
  });

  test("a stale last id falls through to the picker", async () => {
    recordLastWorkbenchId(TENANT_ID, "wb_gone");
    expect(await navigatedTo(["wb_1", "wb_2"])).toEqual(["/new"]);
  });

  test("an empty workbench list falls through to the picker", async () => {
    expect(await navigatedTo([])).toEqual(["/new"]);
  });
});
