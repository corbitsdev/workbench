// The land-hop every entry point funnels through: `/` (HomeRoute)
// resolves to the conversation rail or an existing channel — never
// find-or-creates a Myra conversation. Myra is an agent row, opened
// through the generic POST {kind:chat, definitionId} path like any
// other agent. A brand-new bench with zero conversations lands on
// the empty rail (`/w`), not "Preparing your agent" and not an
// auto-minted Myra DM.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import type { Root } from "react-dom/client";

import { BenchProvider } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import { HomeRoute } from "../src/pages/home-page";
import { TestQueryProvider } from "./test-query-provider";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function stubFetch(respond: (path: string, method: string) => Response) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path =
      typeof input === "string" ? input : new URL(String(input)).pathname;
    return Promise.resolve(respond(path, init?.method ?? "GET"));
  }) as typeof fetch;
}

/** POST `/chat/workbenches` is the Myra ensure/create land-hop. Loader
 * POSTs (membership kinds lookup, etc.) must not land in this list. */
function isWorkbenchCreatePost(path: string, method: string): boolean {
  return method === "POST" && path.includes("/chat/workbenches");
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => act(() => sleep(10));

const PRINCIPALS_RESPONSE = {
  data: [
    {
      principalId: "prn_1",
      tenantId: "tnt_1",
      tenantName: "Growth Team",
      tenantSlug: "growth-team",
      kind: "user",
      status: "active",
      roles: [],
    },
  ],
  nextCursor: null,
};

describe("HomeRoute (the `/` land hop every entry point funnels through)", () => {
  test("`/` does not ensure a Myra conversation — existing rooms stay, no create POST", async () => {
    const workbenchCreatePosts: { path: string; method: string }[] = [];
    stubFetch((path, method) => {
      if (isWorkbenchCreatePost(path, method)) {
        workbenchCreatePosts.push({ path, method });
        return json({
          id: "chan_myra",
          title: "Myra",
          kind: "chat",
          pinned: false,
          participants: [],
        });
      }
      if (path === "/api/me/principals") {
        return json(PRINCIPALS_RESPONSE);
      }
      if (path.includes("/api/workbench-tenancies/kinds")) {
        return json({ workbenchTenantIds: [] });
      }
      if (path.endsWith("/chat/workbenches") && method === "GET") {
        return json({
          items: [
            {
              id: "chan_existing",
              title: "Some workbench",
              kind: "chat",
              pinned: false,
              participants: [],
            },
          ],
        });
      }
      if (method === "POST") {
        return json({});
      }
      throw new Error(`unexpected fetch: ${method} ${path}`);
    });

    const navigated: string[] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TestQueryProvider>
          <NavigationProvider navigate={(to) => navigated.push(to)}>
            <BenchProvider>
              <HomeRoute />
            </BenchProvider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
    for (let i = 0; i < 20; i++) {
      await settle();
      if (navigated.length > 0) break;
    }

    expect(workbenchCreatePosts).toEqual([]);
    expect(navigated).toEqual(["/w"]);
    expect(navigated).not.toContain("/w/chan_myra");
    expect(container?.textContent ?? "").not.toContain("Preparing your agent");
  });

  test("zero-conversation first-run lands on the rail, not Preparing your agent", async () => {
    const workbenchCreatePosts: { path: string; method: string }[] = [];
    stubFetch((path, method) => {
      if (isWorkbenchCreatePost(path, method)) {
        workbenchCreatePosts.push({ path, method });
        return json({
          id: "chan_myra",
          title: "Myra",
          kind: "chat",
          pinned: false,
          participants: [],
        });
      }
      if (path === "/api/me/principals") {
        return json(PRINCIPALS_RESPONSE);
      }
      if (path.includes("/api/workbench-tenancies/kinds")) {
        return json({ workbenchTenantIds: [] });
      }
      if (path.endsWith("/chat/workbenches") && method === "GET") {
        return json({ items: [] });
      }
      if (path === "/api/onboarding/provisioning-status") {
        return json({ kind: "ready", setupAgentReady: true });
      }
      if (path === "/api/tenants/tnt_1/credentials") {
        return json({ data: [{ status: "active" }], nextCursor: null });
      }
      if (method === "POST") {
        return json({});
      }
      throw new Error(`unexpected fetch: ${method} ${path}`);
    });

    const navigated: string[] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TestQueryProvider>
          <NavigationProvider navigate={(to) => navigated.push(to)}>
            <BenchProvider>
              <HomeRoute />
            </BenchProvider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
    for (let i = 0; i < 20; i++) {
      await settle();
      if (navigated.length > 0) break;
    }

    expect(workbenchCreatePosts).toEqual([]);
    expect(container?.textContent ?? "").not.toContain("Preparing your agent");
    expect(navigated).toEqual(["/w"]);
  });
});

describe("the wait right after connecting a provider", () => {
  function benchWhereMyraArrivesAfter(readyAfter: number) {
    let statusReads = 0;
    const state = { statusCalls: 0 };
    stubFetch((path, method) => {
      if (path === "/api/me/principals") return json(PRINCIPALS_RESPONSE);
      if (path.endsWith("/chat/workbenches") && method === "GET") {
        return json({ items: [] });
      }
      if (path === "/api/tenants/tnt_1/credentials") {
        return json({ data: [{ status: "active" }], nextCursor: null });
      }
      if (path === "/api/onboarding/provisioning-status") {
        statusReads += 1;
        state.statusCalls += 1;
        const setupAgentReady = statusReads > readyAfter;
        return json({
          kind: "provisioning",
          setupAgentReady,
          deployed: [],
          pending: ["assistant"],
        });
      }
      throw new Error(`unexpected fetch: ${method} ${path}`);
    });
    return state;
  }

  function renderHome(props: {
    readonly retryMs: number;
    readonly stallAfterMs: number;
    readonly navigated: string[];
  }) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    return act(async () => {
      root?.render(
        <TestQueryProvider>
          <NavigationProvider navigate={(to) => props.navigated.push(to)}>
            <BenchProvider>
              <HomeRoute
                retryMs={props.retryMs}
                stallAfterMs={props.stallAfterMs}
              />
            </BenchProvider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
  }

  test("skip with no credential lands on an honest next step instead of stuck workbench-ready copy (CL-6780)", async () => {
    stubFetch((path, method) => {
      if (path === "/api/me/principals") return json(PRINCIPALS_RESPONSE);
      if (path.endsWith("/chat/workbenches") && method === "GET") {
        return json({ items: [] });
      }
      if (path === "/api/tenants/tnt_1/credentials") {
        return json({ data: [], nextCursor: null });
      }
      if (path === "/api/onboarding/provisioning-status") {
        return json({
          kind: "provisioning",
          setupAgentReady: false,
          deployed: [],
          pending: ["assistant"],
        });
      }
      throw new Error(`unexpected fetch: ${method} ${path}`);
    });

    const navigated: string[] = [];
    await renderHome({ retryMs: 10, stallAfterMs: 10_000, navigated });
    for (let i = 0; i < 40; i++) {
      await settle();
      const text = container?.textContent ?? "";
      if (text.includes("Connect a provider") || navigated.length > 0) break;
    }

    const text = container?.textContent ?? "";
    expect(text).not.toContain("Getting your workbench ready");
    expect(text).not.toContain("Preparing your agent");
    expect(text).toContain("Connect a provider");
    expect(navigated).toEqual([]);
  });

  test("lands the moment the rail can open, without waiting on the rest of the seeds", async () => {
    const state = benchWhereMyraArrivesAfter(1);
    const navigated: string[] = [];
    await renderHome({ retryMs: 10, stallAfterMs: 10_000, navigated });
    for (let i = 0; i < 40; i++) {
      await settle();
      if (navigated.length > 0) break;
    }

    expect(navigated).toEqual(["/w"]);
    expect(state.statusCalls).toBeGreaterThan(0);
  });
});

describe('a failed memberships fetch never reads as "pick from the switcher"', () => {
  test("shows an error state with Retry, not the empty-selection copy", async () => {
    let principalsCalls = 0;
    stubFetch((path) => {
      if (path === "/api/me/principals") {
        principalsCalls += 1;
        return json({ error: "boom" }, 500);
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TestQueryProvider>
          <NavigationProvider navigate={() => undefined}>
            <BenchProvider>
              <HomeRoute />
            </BenchProvider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
    await settle();
    await settle();

    expect(container.textContent).not.toContain("No workbench selected");
    expect(container.textContent).not.toContain(
      "Pick a workbench from the switcher",
    );
    expect(container.textContent).toContain("Couldn't load your workbenches");

    const retryButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry",
    );
    expect(retryButton).not.toBeUndefined();

    const callsBeforeRetry = principalsCalls;
    await act(async () => {
      retryButton?.click();
    });
    await settle();

    expect(principalsCalls).toBeGreaterThan(callsBeforeRetry);
  });
});

describe("the other two entries land on the same `/` hop", () => {
  test("signing in navigates home (or `next=`), not a dashboard of its own", () => {
    const source = readFileSync(
      new URL("../src/main.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(
      /handleSignedIn[\s\S]*?navigate\(validatedNextPath\(window\.location\.search\)\)/,
    );
  });

  test("onboarding hands off to `/` once a working credential is confirmed", () => {
    const source = readFileSync(
      new URL("../src/pages/onboarding-page.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain('navigate("/")');
  });
});
