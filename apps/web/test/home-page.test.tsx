// The land-hop every entry point funnels through: `/` (HomeRoute)
// resolves to one of two places depending on whether the bench has any
// workbenches yet. `/` is a hop onto the most-recent existing workbench
// or Myra's one DM, never the picker. A bench with one or more hops
// onto `workbenches[0]` — the listing's first row — without minting or
// ensuring Myra. A brand-new bench with zero workbenches waits for
// Myra's own definition to exist, then opens her DM the same way
// "Talk to Myra" does (`openAgentDmChat`) — never `/new`, no
// `ensureMyraWorkbench`, no second creation path. All three entries
// CL-6081 asks for (a direct visit to `/`, `main.tsx`'s post-login
// `navigate("/")`, and the onboarding wizard's post-credential hand-off)
// resolve through this exact hop, so proving HomeRoute itself lands
// correctly in both cases proves the direct-`/` case fully; the other
// two are proven by the narrower source assertions below, which pin the
// exact call each entry point makes onto this same route.

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

function stubFetch(
  respond: (path: string, method: string, init?: RequestInit) => Response,
) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path =
      typeof input === "string" ? input : new URL(String(input)).pathname;
    return Promise.resolve(respond(path, init?.method ?? "GET", init));
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

const MYRA_DEFINITION = {
  id: "wfd_assistant",
  tenantId: "tnt_1",
  name: "assistant",
  currentVersion: "1",
  status: "deployed",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const MYRA_DM = {
  id: "chan_myra_dm",
  title: "Myra",
  kind: "chat",
  pinned: false,
  participants: [],
};

function respondMyraDmLaunch(path: string, method: string) {
  if (path.includes("/workflows/definitions")) {
    return json({ data: [MYRA_DEFINITION], nextCursor: null });
  }
  if (path === "/api/tenants/tnt_1/chat/workbenches" && method === "POST") {
    return json(MYRA_DM);
  }
  return null;
}

describe("HomeRoute (the `/` land hop every entry point funnels through)", () => {
  test("a bench with an existing workbench hops onto the first listed workbench, never minting Myra", async () => {
    stubFetch((path, method) => {
      if (path === "/api/me/principals") {
        return json(PRINCIPALS_RESPONSE);
      }
      if (path.endsWith("/chat/workbenches") && method === "GET") {
        // The all-kinds emptiness check (`listAllWorkbenches`) finds an
        // existing workbench, so the hop lands on that row — not a
        // hidden Myra DM.
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
      if (path.endsWith("/chat/workbenches") && method === "POST") {
        throw new Error(
          `unexpected POST ${path} — HomeRoute must not mint a Myra workbench`,
        );
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

    expect(navigated).toEqual(["/w/chan_existing"]);
  });

  test("a brand-new bench with zero workbenches opens Myra's one DM, not the guided picker", async () => {
    let posted: unknown;
    stubFetch((path, method, init) => {
      if (path === "/api/me/principals") {
        return json(PRINCIPALS_RESPONSE);
      }
      if (path.endsWith("/chat/workbenches") && method === "GET") {
        // listAllWorkbenches finds nothing — this bench has no workbenches
        // yet, so HomeRoute waits for Myra's readiness and opens her DM
        // rather than sending anyone to `/new`.
        return json({ items: [] });
      }
      if (path === "/api/onboarding/provisioning-status") {
        return json({ kind: "ready", setupAgentReady: true });
      }
      if (path.includes("/workflows/definitions")) {
        return json({ data: [MYRA_DEFINITION], nextCursor: null });
      }
      if (path === "/api/tenants/tnt_1/chat/workbenches" && method === "POST") {
        posted = JSON.parse(String(init?.body));
        return json(MYRA_DM);
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

    expect(posted).toEqual({
      kind: "chat",
      definitionId: "wfd_assistant",
      reuseExisting: true,
    });
    expect(navigated).toEqual(["/w/chan_myra_dm"]);
  });
});

// CL-6462: what someone sees between "connect a provider" and "talking to
// Myra". The old answer was a bare centred "0 of 5 ready" on an empty
// page; these pin the replacement — one warm loader, no counts, a land
// that happens the moment Myra herself can answer, and an honest way out
// if she never does.
describe("the wait right after connecting a provider", () => {
  /** A bench with no workbenches yet whose setup agent (Myra) reports
   * ready only after `readyAfter` reads — everything before that is the
   * window the person spends waiting. */
  function benchWhereMyraArrivesAfter(readyAfter: number) {
    let statusReads = 0;
    const state = { statusCalls: 0 };
    stubFetch((path, method) => {
      if (path === "/api/me/principals") return json(PRINCIPALS_RESPONSE);
      if (path.endsWith("/chat/workbenches") && method === "GET") {
        return json({ items: [] });
      }
      // CL-6780: while Myra is still coming online we also confirm a
      // credential exists — without one the drain never starts, so the
      // wait must not pretend a workbench is "getting ready".
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
      const myraLaunch = respondMyraDmLaunch(path, method);
      if (myraLaunch !== null) return myraLaunch;
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
    // CL-6780: zero workbenches yet — this wait is for the agent, not a
    // workbench that does not exist.
    expect(text).toContain("Preparing your agent");
    expect(text).not.toContain("Getting your workbench ready");
    expect(text).toContain("Tip:");
    expect(text).not.toMatch(/\d+ of \d+/);
    expect(text).not.toMatch(/\d/);
    expect(navigated).toEqual([]);
  });

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
    expect(text).toContain("Connect a provider");
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

    expect(navigated).toEqual(["/w/chan_myra_dm"]);
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
      (button) => button.textContent === "Retry",
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

    expect(navigated).toEqual(["/w/chan_myra_dm"]);
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
