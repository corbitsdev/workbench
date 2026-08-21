// The land-hop every entry point funnels through: `/` (HomeRoute)
// resolves to one of two places depending on whether the bench has any
// workbenches yet. A bench with one or more ensures Myra's workbench exists
// and opens it — the same land-hop CL-6081 wired up. A brand-new bench
// with zero workbenches auto-mints its first Myra workbench through the
// exact same one-creation-verb path every "+ New workbench" control uses
// (CL-6138, superseding CL-6104's guided describe screen) and lands
// straight in it — no separate first-run form, no second creation path.
// All three entries CL-6081 asks for (a direct visit to `/`, `main.tsx`'s
// post-login `navigate("/")`, and the onboarding wizard's
// post-credential hand-off) resolve through this exact hop, so proving
// HomeRoute itself lands correctly in both cases proves the direct-`/`
// case fully; the other two are proven by the narrower source assertions
// below, which pin the exact call each entry point makes onto this same
// route.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import type { Root } from "react-dom/client";

import { BenchProvider } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import { HomeRoute } from "../src/pages/home-page";
import { resetMyraWorkbenchCache } from "../src/myra-workbench";
import { TestQueryProvider } from "./test-query-provider";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  resetMyraWorkbenchCache();
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
  test("a bench with an existing workbench ensures Myra's workbench and navigates straight into it", async () => {
    stubFetch((path, method) => {
      if (path === "/api/me/principals") {
        return json(PRINCIPALS_RESPONSE);
      }
      if (path.endsWith("/chat/workbenches") && method === "GET") {
        // The all-kinds emptiness check (`listAllWorkbenches`) finds an
        // existing workbench, so the ensure+redirect hop below runs.
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
      if (path.endsWith("/chat/workbenches?kind=workbench")) {
        return json({ items: [] });
      }
      if (path.endsWith("/chat/workbenches?kind=chat")) {
        return json({ items: [] });
      }
      if (path.includes("/workflows/definitions")) {
        return json({
          data: [
            {
              id: "wfd_assistant",
              tenantId: "tnt_1",
              name: "assistant",
              currentVersion: "1",
              status: "deployed",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          nextCursor: null,
        });
      }
      if (path.endsWith("/chat/workbenches") && method === "POST") {
        return json({
          id: "chan_myra",
          title: "Myra",
          kind: "chat",
          pinned: false,
          participants: [],
        });
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

    expect(navigated).toEqual(["/w/chan_myra"]);
  });

  test("a brand-new bench with zero workbenches auto-mints its first Myra workbench and lands in it", async () => {
    stubFetch((path, method) => {
      if (path === "/api/me/principals") {
        return json(PRINCIPALS_RESPONSE);
      }
      if (path.endsWith("/chat/workbenches") && method === "GET") {
        // listAllWorkbenches finds nothing — this bench has no workbenches
        // yet, so HomeRoute mints one via the default setup template
        // rather than calling ensureMyraWorkbench (which only ever finds
        // or reuses an existing one).
        return json({ items: [] });
      }
      if (path.includes("/workflows/definitions")) {
        return json({
          data: [
            {
              id: "wfd_assistant",
              tenantId: "tnt_1",
              name: "assistant",
              currentVersion: "1",
              status: "deployed",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          nextCursor: null,
        });
      }
      if (path.endsWith("/chat/workbenches") && method === "POST") {
        return json({
          id: "chan_new",
          title: "New Workbench",
          kind: "chat",
          pinned: false,
          participants: [],
        });
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

    expect(navigated).toEqual(["/w/chan_new"]);
  });
});

// CL-6462: what someone sees between "connect a provider" and "talking to
// Myra". The old answer was a bare centred "0 of 5 ready" on an empty
// page; these pin the replacement — one warm loader, no counts, a land
// that happens the moment Myra herself can answer, and an honest way out
// if she never does.
describe("the wait right after connecting a provider", () => {
  /** A bench with no workbenches yet whose agent definitions arrive only
   * after `readyAfter` reads — everything before that is the window the
   * person spends waiting. */
  function benchWhereMyraArrivesAfter(readyAfter: number, provisioning = true) {
    let definitionReads = 0;
    const state = { statusCalls: 0 };
    stubFetch((path, method) => {
      if (path === "/api/me/principals") return json(PRINCIPALS_RESPONSE);
      if (path.endsWith("/chat/workbenches") && method === "GET") {
        return json({ items: [] });
      }
      if (path.includes("/workflows/definitions")) {
        definitionReads += 1;
        return json({
          data:
            definitionReads > readyAfter
              ? [
                  {
                    id: "wfd_assistant",
                    tenantId: "tnt_1",
                    name: "assistant",
                    currentVersion: "1",
                    status: "deployed",
                    createdAt: "2026-01-01T00:00:00.000Z",
                    updatedAt: "2026-01-01T00:00:00.000Z",
                  },
                ]
              : [],
          nextCursor: null,
        });
      }
      if (path === "/api/onboarding/provisioning-status") {
        state.statusCalls += 1;
        return json({
          kind: provisioning ? "provisioning" : "ready",
          setupAgentReady: !provisioning,
          deployed: [],
          pending: ["assistant"],
        });
      }
      if (path.endsWith("/chat/workbenches") && method === "POST") {
        return json({
          id: "chan_new",
          title: "New Workbench",
          kind: "chat",
          pinned: false,
          participants: [],
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

  test("shows the warm loader while Myra is still coming online — never a count", async () => {
    benchWhereMyraArrivesAfter(99);
    const navigated: string[] = [];
    await renderHome({ retryMs: 10, stallAfterMs: 10_000, navigated });
    for (let i = 0; i < 40; i++) {
      await settle();
      if ((container?.textContent ?? "") !== "") break;
    }

    const text = container?.textContent ?? "";
    expect(text).toContain("Getting your workbench ready");
    expect(text).toContain("Tip:");
    expect(text).not.toMatch(/\d+ of \d+/);
    expect(text).not.toMatch(/\d/);
    expect(navigated).toEqual([]);
  });

  test("lands the moment Myra can answer, without waiting on the rest of the seeds", async () => {
    // The status route still says "provisioning" — other workflows are
    // mid-deploy — and the land happens anyway.
    const state = benchWhereMyraArrivesAfter(1);
    const navigated: string[] = [];
    await renderHome({ retryMs: 10, stallAfterMs: 10_000, navigated });
    for (let i = 0; i < 40; i++) {
      await settle();
      if (navigated.length > 0) break;
    }

    expect(navigated).toEqual(["/w/chan_new"]);
    expect(state.statusCalls).toBeGreaterThan(0);
  });

  test("says so honestly with a retry once the wait has gone on too long", async () => {
    benchWhereMyraArrivesAfter(99);
    const navigated: string[] = [];
    await renderHome({ retryMs: 10, stallAfterMs: 40, navigated });
    for (let i = 0; i < 40; i++) {
      await settle();
      if ((container?.textContent ?? "").includes("longer than usual")) break;
    }

    const text = container?.textContent ?? "";
    expect(text).toContain("Myra is taking longer than usual");
    expect(text).not.toMatch(/\d+ of \d+/);
    const retry = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Try again",
    );
    expect(retry).not.toBeUndefined();
  });

  test("auto-navigates once Myra becomes ready even after the stall message fires, with no click", async () => {
    // Myra doesn't answer until well past the stall threshold — the slow
    // message must not be the end of the line. Polling keeps going
    // underneath it, and the land happens on its own once she's ready.
    benchWhereMyraArrivesAfter(6);
    const navigated: string[] = [];
    await renderHome({ retryMs: 10, stallAfterMs: 40, navigated });
    for (let i = 0; i < 40; i++) {
      await settle();
      if ((container?.textContent ?? "").includes("longer than usual")) break;
    }
    expect(container?.textContent ?? "").toContain(
      "Myra is taking longer than usual",
    );

    for (let i = 0; i < 60; i++) {
      await settle();
      if (navigated.length > 0) break;
    }

    expect(navigated).toEqual(["/w/chan_new"]);
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
    // CL-6369: a plain sign-in still lands on `/` — `validatedNextPath`
    // defaults there with no `next=` param — but a sign-in redirected
    // through `/login?next=...` returns to that path instead, so the
    // literal `navigate("/")` call this test used to pin no longer
    // applies unconditionally.
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
